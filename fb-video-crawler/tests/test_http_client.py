"""Tests for retry and rate-limiting HTTP behavior."""

from collections.abc import Callable

import httpx
import pytest

from fb_crawler.errors import FacebookHTTPError
from fb_crawler.http_client import Fetcher


class FakeClient:
    def __init__(self, outcomes: list[httpx.Response | Exception]) -> None:
        self._outcomes = list(outcomes)
        self.requested_urls: list[str] = []

    def get(self, url: str) -> httpx.Response:
        self.requested_urls.append(url)
        outcome = self._outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def close(self) -> None:
        return None


class FakeClock:
    def __init__(self) -> None:
        self.current = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.current

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.current += seconds


def make_response(status_code: int, url: str = "https://www.facebook.com/") -> httpx.Response:
    request = httpx.Request("GET", url)
    return httpx.Response(status_code, request=request, text="response body")


def make_network_error() -> httpx.ConnectError:
    request = httpx.Request("GET", "https://www.facebook.com/")
    return httpx.ConnectError("network unavailable", request=request)


def build_fetcher(
    outcomes: list[httpx.Response | Exception],
    clock: FakeClock,
    **kwargs: float | int,
) -> tuple[Fetcher, FakeClient]:
    client = FakeClient(outcomes)
    fetcher = Fetcher(
        client=client,
        clock=clock.monotonic,
        sleep=clock.sleep,
        **kwargs,
    )
    return fetcher, client


def test_fetcher_retries_5xx_then_returns_success() -> None:
    # Arrange
    clock = FakeClock()
    fetcher, client = build_fetcher(
        [make_response(500), make_response(502), make_response(200)],
        clock,
        min_interval_s=0,
        max_retries=2,
        backoff_factor_s=0.25,
    )

    # Act
    response = fetcher.get("https://www.facebook.com/watch/?v=123")

    # Assert
    assert response.status_code == 200
    assert len(client.requested_urls) == 3
    assert clock.sleeps == [0.25, 0.5]


def test_fetcher_retries_network_errors() -> None:
    # Arrange
    clock = FakeClock()
    fetcher, client = build_fetcher(
        [make_network_error(), make_response(200)],
        clock,
        min_interval_s=0,
        max_retries=1,
        backoff_factor_s=0,
    )

    # Act
    response = fetcher.get("https://www.facebook.com/watch/?v=123")

    # Assert
    assert response.status_code == 200
    assert len(client.requested_urls) == 2


def test_fetcher_follows_redirects_and_sends_desktop_user_agent() -> None:
    # Arrange
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/start":
            return httpx.Response(302, headers={"Location": "/final"})
        return httpx.Response(200, text="done")

    transport = httpx.MockTransport(handler)

    # Act
    with Fetcher(min_interval_s=0, max_retries=0, transport=transport) as fetcher:
        response = fetcher.get("https://www.facebook.com/start")

    # Assert
    assert response.status_code == 200
    assert response.text == "done"
    assert len(requests) == 2
    assert "Chrome/" in requests[0].headers["User-Agent"]


def test_fetcher_enforces_minimum_interval_between_calls() -> None:
    # Arrange
    clock = FakeClock()
    fetcher, _ = build_fetcher(
        [make_response(200), make_response(200)],
        clock,
        min_interval_s=2,
        max_retries=0,
    )

    # Act
    fetcher.get("https://www.facebook.com/watch/?v=123")
    fetcher.get("https://www.facebook.com/watch/?v=456")

    # Assert
    assert clock.sleeps == [2.0]


def test_fetcher_raises_after_persistent_failure() -> None:
    # Arrange
    clock = FakeClock()
    fetcher, client = build_fetcher(
        [make_response(503), make_response(503), make_response(503)],
        clock,
        min_interval_s=0,
        max_retries=2,
        backoff_factor_s=0,
    )

    # Act and Assert
    with pytest.raises(FacebookHTTPError, match="503") as caught:
        fetcher.get("https://www.facebook.com/watch/?v=123")
    assert caught.value.status_code == 503
    assert len(client.requested_urls) == 3


def test_fetcher_raises_after_persistent_network_failure() -> None:
    # Arrange
    clock = FakeClock()
    fetcher, client = build_fetcher(
        [make_network_error(), make_network_error()],
        clock,
        min_interval_s=0,
        max_retries=1,
        backoff_factor_s=0,
    )

    # Act and Assert
    with pytest.raises(FacebookHTTPError, match="network unavailable") as caught:
        fetcher.get("https://www.facebook.com/watch/?v=123")
    assert caught.value.status_code is None
    assert len(client.requested_urls) == 2


def test_fetcher_raises_immediately_for_4xx() -> None:
    # Arrange
    clock = FakeClock()
    fetcher, client = build_fetcher(
        [make_response(404)],
        clock,
        min_interval_s=0,
        max_retries=2,
    )

    # Act and Assert
    with pytest.raises(FacebookHTTPError, match="404"):
        fetcher.get("https://www.facebook.com/watch/?v=123")
    assert len(client.requested_urls) == 1


def test_fetcher_rejects_invalid_url_and_conflicting_injection() -> None:
    # Arrange
    client = FakeClient([make_response(200)])

    # Act and Assert
    with pytest.raises(FacebookHTTPError, match="Invalid HTTP URL"):
        Fetcher(client=client).get("not-a-url")
    with pytest.raises(ValueError, match="either client or transport"):
        Fetcher(client=client, transport=httpx.MockTransport(lambda request: make_response(200)))


@pytest.mark.parametrize(
    ("keyword", "value"),
    [
        ("min_interval_s", -1.0),
        ("max_retries", -1),
        ("backoff_factor_s", -1.0),
        ("timeout_s", 0),
    ],
)
def test_fetcher_rejects_invalid_configuration(keyword: str, value: float | int) -> None:
    # Arrange
    arguments: dict[str, float | int | Callable[[], float]] = {keyword: value}

    # Act and Assert
    with pytest.raises(ValueError):
        Fetcher(**arguments)  # type: ignore[arg-type]
