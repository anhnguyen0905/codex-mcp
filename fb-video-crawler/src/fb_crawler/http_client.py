"""Rate-limited HTTP fetching with retries for transient failures."""

from collections.abc import Callable
import time
from types import TracebackType
from typing import Protocol, Self
from urllib.parse import urljoin, urlsplit

import httpx

from fb_crawler.errors import (
    FacebookHTTPError,
    FacebookRedirectError,
    FacebookResponseTooLargeError,
)
from fb_crawler.url_utils import is_facebook_https_url

DESKTOP_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)
DEFAULT_TIMEOUT_S = 20.0
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
MAX_REDIRECTS = 5


class HTTPClient(Protocol):
    """The subset of an HTTP client used by Fetcher."""

    def get(self, url: str) -> httpx.Response: ...

    def close(self) -> None: ...


class Fetcher:
    """Fetch pages while spacing requests and retrying transient errors."""

    def __init__(
        self,
        min_interval_s: float = 1.0,
        max_retries: int = 2,
        *,
        backoff_factor_s: float = 0.5,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        client: HTTPClient | None = None,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        _validate_configuration(min_interval_s, max_retries, backoff_factor_s, timeout_s)
        if client is not None and transport is not None:
            raise ValueError("Pass either client or transport, not both")

        self.min_interval_s = float(min_interval_s)
        self.max_retries = max_retries
        self.backoff_factor_s = float(backoff_factor_s)
        self._clock = clock
        self._sleep = sleep
        self._last_request_started_at: float | None = None
        self._owns_client = client is None
        self._client = client if client is not None else _build_client(timeout_s, transport)

    def get(self, url: str) -> httpx.Response:
        """Fetch a URL, retrying 5xx responses and request errors.

        Redirect targets are validated before being followed, and responses
        larger than ``MAX_RESPONSE_BYTES`` raise instead of being truncated.
        """
        _validate_https_url(url)
        last_error: httpx.RequestError | None = None
        last_response: httpx.Response | None = None
        failure_history: list[str] = []

        for attempt in range(self.max_retries + 1):
            self._wait_for_rate_limit()
            try:
                response = self._get_following_redirects(url)
            except httpx.RequestError as exc:
                last_error, last_response = exc, None
                failure_history.append(str(exc))
            else:
                if response.status_code < 400:
                    _enforce_response_size_limit(response, url)
                    return response
                if response.status_code < 500:
                    raise _response_error(response, url)
                last_error, last_response = None, response
                failure_history.append(f"HTTP {response.status_code}")
            if attempt < self.max_retries:
                self._sleep(self.backoff_factor_s * (2**attempt))

        raise _final_attempt_error(
            url,
            attempts=self.max_retries + 1,
            failure_history=failure_history,
            last_response=last_response,
            last_error=last_error,
        )

    def _get_following_redirects(self, url: str) -> httpx.Response:
        """Follow redirects manually so every target is validated first."""
        current_url = url
        for _ in range(MAX_REDIRECTS + 1):
            response = self._client.get(current_url)
            location = response.headers.get("location", "").strip()
            if not (300 <= response.status_code < 400) or not location:
                return response
            current_url = _validated_redirect_target(current_url, location)
        raise FacebookRedirectError(
            f"Too many redirects for GET {url} (limit {MAX_REDIRECTS})",
            url=current_url,
        )

    def close(self) -> None:
        """Close the internally-created HTTP client."""
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def _wait_for_rate_limit(self) -> None:
        now = self._clock()
        if self._last_request_started_at is not None:
            elapsed = now - self._last_request_started_at
            remaining = self.min_interval_s - elapsed
            if remaining > 0:
                self._sleep(remaining)
                now = self._clock()
        self._last_request_started_at = now


def _validate_configuration(
    min_interval_s: float,
    max_retries: int,
    backoff_factor_s: float,
    timeout_s: float,
) -> None:
    if min_interval_s < 0:
        raise ValueError("min_interval_s must be non-negative")
    if not isinstance(max_retries, int) or max_retries < 0:
        raise ValueError("max_retries must be a non-negative integer")
    if backoff_factor_s < 0:
        raise ValueError("backoff_factor_s must be non-negative")
    if timeout_s <= 0:
        raise ValueError("timeout_s must be positive")


def _build_client(
    timeout_s: float,
    transport: httpx.BaseTransport | None,
) -> httpx.Client:
    # Redirects are followed manually by Fetcher so that every target is
    # validated (https + facebook host) BEFORE it is requested.
    return httpx.Client(
        headers={"User-Agent": DESKTOP_USER_AGENT},
        follow_redirects=False,
        timeout=timeout_s,
        transport=transport,
    )


def _validate_https_url(url: str) -> None:
    if isinstance(url, str) and urlsplit(url).scheme == "http":
        raise FacebookHTTPError(
            f"HTTPS is required; refusing to fetch plain http:// URL: {url!r}",
            url=url,
        )
    if not isinstance(url, str) or urlsplit(url).scheme != "https":
        raise FacebookHTTPError(f"Invalid HTTP URL: {url!r}", url=str(url))


def _validated_redirect_target(current_url: str, location: str) -> str:
    target = urljoin(current_url, location)
    if not is_facebook_https_url(target):
        raise FacebookRedirectError(
            f"Blocked redirect to disallowed target {target!r}: only https URLs "
            "on facebook.com domains may be followed",
            url=target,
        )
    return target


def _enforce_response_size_limit(response: httpx.Response, url: str) -> None:
    declared_size = _declared_content_length(response)
    actual_size = max(declared_size or 0, len(response.content))
    if actual_size > MAX_RESPONSE_BYTES:
        raise FacebookResponseTooLargeError(
            f"Response for GET {url} is {actual_size} bytes, which exceeds the "
            f"{MAX_RESPONSE_BYTES}-byte limit",
            status_code=response.status_code,
            url=url,
        )


def _declared_content_length(response: httpx.Response) -> int | None:
    declared = response.headers.get("content-length", "").strip()
    return int(declared) if declared.isdigit() else None


def _response_error(response: httpx.Response, fallback_url: str) -> FacebookHTTPError:
    response_url = str(response.url) if response.url else fallback_url
    return FacebookHTTPError(
        f"GET {response_url} returned HTTP {response.status_code}",
        status_code=response.status_code,
        url=response_url,
    )


def _final_attempt_error(
    url: str,
    *,
    attempts: int,
    failure_history: list[str],
    last_response: httpx.Response | None,
    last_error: httpx.RequestError | None,
) -> FacebookHTTPError:
    """Build an error that reflects the LAST attempt's actual failure."""
    last_failure = failure_history[-1] if failure_history else "unknown network error"
    earlier = failure_history[:-1]
    earlier_context = f" (earlier attempts: {', '.join(earlier)})" if earlier else ""
    message = (
        f"GET {url} failed after {attempts} attempts; "
        f"last error: {last_failure}{earlier_context}"
    )
    status_code = last_response.status_code if last_response is not None else None
    error = FacebookHTTPError(message, status_code=status_code, url=url)
    error.__cause__ = last_error
    return error
