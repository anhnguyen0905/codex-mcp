"""Rate-limited HTTP fetching with retries for transient failures."""

from collections.abc import Callable
import time
from types import TracebackType
from typing import Protocol, Self
from urllib.parse import urlsplit

import httpx

from fb_crawler.errors import FacebookHTTPError

DESKTOP_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)
DEFAULT_TIMEOUT_S = 20.0


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
        """Fetch a URL, retrying 5xx responses and request errors."""
        _validate_http_url(url)
        last_error: httpx.RequestError | None = None
        last_response: httpx.Response | None = None

        for attempt in range(self.max_retries + 1):
            self._wait_for_rate_limit()
            try:
                response = self._client.get(url)
            except httpx.RequestError as exc:
                last_error = exc
            else:
                last_response = response
                if response.status_code < 400:
                    return response
                if response.status_code < 500:
                    raise _response_error(response, url)
            if attempt < self.max_retries:
                self._sleep(self.backoff_factor_s * (2**attempt))

        if last_response is not None:
            raise _response_error(last_response, url)
        detail = str(last_error) if last_error is not None else "unknown network error"
        raise FacebookHTTPError(
            f"GET {url} failed after {self.max_retries + 1} attempts: {detail}",
            url=url,
        ) from last_error

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
    return httpx.Client(
        headers={"User-Agent": DESKTOP_USER_AGENT},
        follow_redirects=True,
        timeout=timeout_s,
        transport=transport,
    )


def _validate_http_url(url: str) -> None:
    if not isinstance(url, str) or urlsplit(url).scheme not in {"http", "https"}:
        raise FacebookHTTPError(f"Invalid HTTP URL: {url!r}", url=str(url))


def _response_error(response: httpx.Response, fallback_url: str) -> FacebookHTTPError:
    response_url = str(response.url) if response.url else fallback_url
    return FacebookHTTPError(
        f"GET {response_url} returned HTTP {response.status_code}",
        status_code=response.status_code,
        url=response_url,
    )
