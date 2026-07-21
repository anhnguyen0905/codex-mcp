"""Tests for parsing Facebook Open Graph video metrics."""

from pathlib import Path

import httpx
import pytest

from fb_crawler.errors import FacebookParseError, FacebookVideoMismatchError
from fb_crawler.metrics import fetch_metrics, parse_metrics

FIXTURES = Path(__file__).parent / "fixtures"
REAL_VIDEO_ID = "10153231379946729"


def build_og_html(title: str) -> str:
    return (
        f'<meta property="og:title" content="{title}">'
        '<meta property="og:url" content="https://facebook.com/reel/123/">'
        '<meta property="og:description" content="Description">'
    )


class StubFetcher:
    def __init__(self, html: str) -> None:
        self.html = html
        self.requested_urls: list[str] = []

    def get(self, url: str) -> httpx.Response:
        self.requested_urls.append(url)
        request = httpx.Request("GET", url)
        return httpx.Response(200, request=request, text=self.html)


def test_parse_metrics_from_real_facebook_fixture() -> None:
    # Arrange
    html = (FIXTURES / "video_page_real.html").read_text(encoding="utf-8")

    # Act
    metrics = parse_metrics(html)

    # Assert
    assert metrics.video_id == REAL_VIDEO_ID
    assert metrics.url == f"https://www.facebook.com/reel/{REAL_VIDEO_ID}/"
    assert "How to share" in metrics.title
    assert metrics.description == "How to share with just friends."
    assert metrics.view_count == pytest.approx(2_800_000)
    assert metrics.reaction_count == pytest.approx(1_300)
    assert metrics.comment_count is None
    assert metrics.share_count is None
    assert any("comment_count" in warning for warning in metrics.warnings)
    assert any("share_count" in warning for warning in metrics.warnings)


def test_parse_metrics_handles_reordered_meta_attributes_and_missing_counts() -> None:
    # Arrange
    html = """
    <html><head>
      <meta content="A plain title | Facebook" property="og:title">
      <meta content="A description &amp; details" property="og:description">
      <meta content="https://www.facebook.com/reel/12345/" property="og:url">
      <meta content="video.other" property="og:type">
    </head></html>
    """

    # Act
    metrics = parse_metrics(html)

    # Assert
    assert metrics.title == "A plain title"
    assert metrics.description == "A description & details"
    assert metrics.view_count is None
    assert metrics.reaction_count is None
    assert any("view_count" in warning for warning in metrics.warnings)
    assert any("reaction_count" in warning for warning in metrics.warnings)


@pytest.mark.parametrize(
    "html",
    [
        '<meta property="og:title" content="Title | Facebook">',
        (
            '<meta property="og:title" content="Title | Facebook">'
            '<meta property="og:url" content="https://facebook.com/reel/123/">'
        ),
        (
            '<meta property="og:title" content="1K views · 2 reactions | Facebook">'
            '<meta property="og:url" content="https://facebook.com/reel/123/">'
            '<meta property="og:description" content="Description">'
        ),
    ],
)
def test_parse_metrics_rejects_incomplete_required_metadata(html: str) -> None:
    # Arrange, Act, and Assert
    with pytest.raises(FacebookParseError):
        parse_metrics(html)


@pytest.mark.parametrize("html", ["", "<html><head></head></html>", None])
def test_parse_metrics_rejects_missing_metadata(html: str | None) -> None:
    # Arrange, Act, and Assert
    with pytest.raises(FacebookParseError):
        parse_metrics(html)  # type: ignore[arg-type]


def test_parse_metrics_assigns_counts_by_label_not_position() -> None:
    # Arrange: reactions listed before views must still map by label.
    html = build_og_html("1K reactions · 2K views | My video | Facebook")

    # Act
    metrics = parse_metrics(html)

    # Assert
    assert metrics.view_count == 2_000
    assert metrics.reaction_count == 1_000


def test_parse_metrics_reads_labeled_comment_and_share_counts() -> None:
    # Arrange
    html = build_og_html("3K views · 1K likes · 10 comments · 5 shares | My video | Facebook")

    # Act
    metrics = parse_metrics(html)

    # Assert
    assert metrics.view_count == 3_000
    assert metrics.reaction_count == 1_000
    assert metrics.comment_count == 10
    assert metrics.share_count == 5
    assert not any("comment_count unavailable" in warning for warning in metrics.warnings)
    assert not any("share_count unavailable" in warning for warning in metrics.warnings)


def test_parse_metrics_never_guesses_unlabeled_counts() -> None:
    # Arrange: counts without labels must not be assigned to any metric.
    html = build_og_html("1K · 2K | My video | Facebook")

    # Act
    metrics = parse_metrics(html)

    # Assert
    assert metrics.view_count is None
    assert metrics.reaction_count is None
    assert any("view_count" in warning for warning in metrics.warnings)
    assert any("reaction_count" in warning for warning in metrics.warnings)
    assert any("no recognized metric label" in warning for warning in metrics.warnings)


def test_fetch_metrics_rejects_video_id_mismatch() -> None:
    # Arrange: page metadata references a different video than requested.
    html = (FIXTURES / "og_tags_real.txt").read_text(encoding="utf-8")
    fetcher = StubFetcher(html)
    url = "https://www.facebook.com/facebook/videos/999888777/"

    # Act and Assert
    with pytest.raises(FacebookVideoMismatchError, match="999888777"):
        fetch_metrics(url, fetcher)  # type: ignore[arg-type]


def test_fetch_metrics_validates_and_fetches_the_requested_url() -> None:
    # Arrange
    html = (FIXTURES / "og_tags_real.txt").read_text(encoding="utf-8")
    fetcher = StubFetcher(html)
    url = f"https://www.facebook.com/facebook/videos/{REAL_VIDEO_ID}/"

    # Act
    metrics = fetch_metrics(url, fetcher)  # type: ignore[arg-type]

    # Assert
    assert metrics.video_id == REAL_VIDEO_ID
    assert fetcher.requested_urls == [url]
