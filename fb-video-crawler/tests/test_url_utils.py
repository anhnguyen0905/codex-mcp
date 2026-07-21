"""Tests for Facebook video URL validation and normalization."""

import pytest

from fb_crawler.errors import FacebookParseError
from fb_crawler.url_utils import canonical_video_url, extract_video_id


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
