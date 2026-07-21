"""Tests for Facebook video URL validation and normalization."""

import pytest

from fb_crawler.errors import FacebookParseError
from fb_crawler.url_utils import canonical_video_url, extract_video_id, is_facebook_https_url


@pytest.mark.parametrize(
    "url",
    [
        "https://www.facebook.com/watch/?v=10153231379946729",
        "https://www.facebook.com/facebook/videos/10153231379946729/",
        "https://m.facebook.com/reel/10153231379946729/",
    ],
)
def test_extract_video_id_from_supported_urls(url: str) -> None:
    # Arrange and Act
    video_id = extract_video_id(url)

    # Assert
    assert video_id == "10153231379946729"


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/watch/?v=123",
        "https://www.facebook.com/watch/?v=not-numeric",
        "https://www.facebook.com/some-page",
        "not a url",
        "",
    ],
)
def test_extract_video_id_rejects_invalid_urls(url: str) -> None:
    # Arrange, Act, and Assert
    with pytest.raises(FacebookParseError):
        extract_video_id(url)


def test_canonical_video_url_accepts_an_id_or_url() -> None:
    # Arrange
    expected = "https://www.facebook.com/watch/?v=10153231379946729"

    # Act and Assert
    assert canonical_video_url("10153231379946729") == expected
    assert canonical_video_url(
        "https://www.facebook.com/reel/10153231379946729/"
    ) == expected


@pytest.mark.parametrize("value", ["", "abc", "https://example.com/videos/123/", None])
def test_canonical_video_url_rejects_invalid_input(value: str | None) -> None:
    # Arrange, Act, and Assert
    with pytest.raises(FacebookParseError):
        canonical_video_url(value)  # type: ignore[arg-type]


def test_extract_video_id_rejects_plain_http_url_with_clear_message() -> None:
    # Arrange
    url = "http://www.facebook.com/watch/?v=10153231379946729"

    # Act and Assert
    with pytest.raises(FacebookParseError, match="HTTPS is required"):
        extract_video_id(url)


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://www.facebook.com/watch/?v=123", True),
        ("https://mbasic.facebook.com/watch/?v=123", True),
        ("https://facebook.com/watch/?v=123", True),
        ("http://www.facebook.com/watch/?v=123", False),
        ("https://evil.example/watch/?v=123", False),
        ("https://notfacebook.com/watch/?v=123", False),
        ("https://facebook.com.evil.example/watch/?v=123", False),
        ("not a url", False),
    ],
)
def test_is_facebook_https_url(url: str, expected: bool) -> None:
    # Arrange, Act, and Assert
    assert is_facebook_https_url(url) is expected


def test_is_facebook_https_url_rejects_non_string_input() -> None:
    # Arrange, Act, and Assert
    assert is_facebook_https_url(None) is False  # type: ignore[arg-type]
