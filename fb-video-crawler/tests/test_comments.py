"""Tests for mbasic-style Facebook comment parsing and collection."""

from pathlib import Path

import httpx
import pytest

from fb_crawler.comments import (
    Comment,
    CommentCollection,
    aggregate_comments,
    collect_comments,
    parse_comments_page,
)
from fb_crawler.errors import (
    FacebookAuthRequiredError,
    FacebookHTTPError,
    FacebookParseError,
)

FIXTURES = Path(__file__).parent / "fixtures"


class SequenceFetcher:
    def __init__(self, pages: list[str | httpx.Response | Exception]) -> None:
        self._pages = list(pages)
        self.requested_urls: list[str] = []

    def get(self, url: str) -> httpx.Response:
        self.requested_urls.append(url)
        outcome = self._pages.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        if isinstance(outcome, httpx.Response):
            return outcome
        return httpx.Response(200, request=httpx.Request("GET", url), text=outcome)


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_parse_comments_page_extracts_comments_and_next_cursor() -> None:
    # Arrange
    html = fixture("comments_page_1.html")

    # Act
    comments, next_cursor = parse_comments_page(html)

    # Assert
    assert [comment.comment_id for comment in comments] == ["c-1001", "c-1002"]
    assert comments[0].author == "Alice Nguyen"
    assert comments[0].text == "Helpful explanation & clear example."
    assert comments[1].like_count == 1_200
    assert comments[1].created_time == "1710000300"
    assert next_cursor == "/watch/?v=123456&p=2&cursor=next-page"


def test_collect_comments_paginates_deduplicates_and_terminates() -> None:
    # Arrange
    fetcher = SequenceFetcher(
        [fixture("comments_page_1.html"), fixture("comments_page_2.html")]
    )

    # Act
    collection = collect_comments("123456", fetcher, max_pages=5)  # type: ignore[arg-type]

    # Assert
    assert isinstance(collection, CommentCollection)
    assert [comment.comment_id for comment in collection.items] == [
        "c-1001",
        "c-1002",
        "c-1003",
        "c-1004",
    ]
    assert collection.has_more is False
    assert collection.truncated is False
    assert collection.stop_reason == "exhausted"
    assert len(fetcher.requested_urls) == 2
    assert fetcher.requested_urls[1].endswith(
        "/watch/?v=123456&p=2&cursor=next-page"
    )


def test_collect_comments_honors_max_pages_and_reports_truncation() -> None:
    # Arrange: page 1 advertises a next cursor that max_pages forbids following.
    fetcher = SequenceFetcher([fixture("comments_page_1.html")])

    # Act
    collection = collect_comments("123456", fetcher, max_pages=1)  # type: ignore[arg-type]

    # Assert
    assert len(collection.items) == 2
    assert collection.has_more is True
    assert collection.truncated is True
    assert collection.stop_reason == "max_pages"
    assert len(fetcher.requested_urls) == 1


def test_collect_comments_returns_empty_collection_for_valid_page_without_comments() -> None:
    # Arrange: a real page with zero comments and no auth-wall markers.
    html = "<html><body><div class='story'>No comments yet.</div></body></html>"
    fetcher = SequenceFetcher([html])

    # Act
    collection = collect_comments("123456", fetcher, max_pages=1)  # type: ignore[arg-type]

    # Assert
    assert collection.items == ()
    assert collection.has_more is False
    assert collection.truncated is False
    assert collection.stop_reason == "exhausted"


def test_aggregate_comments_counts_authors() -> None:
    # Arrange
    comments = [
        Comment("1", "Alice", "First", 0, "100"),
        Comment("2", "Bob", "Second", 2, "200"),
        Comment("3", "Alice", "Third", 1, "300"),
    ]

    # Act
    summary = aggregate_comments(comments)

    # Assert
    assert summary.total == 3
    assert summary.unique_authors == 2
    assert summary.top_authors == (("Alice", 2), ("Bob", 1))


@pytest.mark.parametrize(
    "outcome",
    [
        FacebookHTTPError("HTTP 400", status_code=400),
        httpx.Response(
            302,
            headers={"Location": "https://mbasic.facebook.com/login/"},
            request=httpx.Request("GET", "https://mbasic.facebook.com/watch/?v=123456"),
        ),
        "",
        '<html><form id="login_form"></form></html>',
    ],
)
def test_collect_comments_raises_clear_error_at_login_wall(
    outcome: str | httpx.Response | Exception,
) -> None:
    # Arrange
    fetcher = SequenceFetcher([outcome])

    # Act and Assert
    with pytest.raises(FacebookAuthRequiredError, match="session cookie or token"):
        collect_comments("123456", fetcher, max_pages=1)  # type: ignore[arg-type]


def test_parse_comments_page_rejects_invalid_comment_nodes() -> None:
    # Arrange
    html = '<div class="comment" data-comment-id="1"><div>missing fields</div></div>'

    # Act and Assert
    with pytest.raises(FacebookParseError, match="missing required fields"):
        parse_comments_page(html)


def test_parse_comments_page_supports_text_cursor_and_default_like_count() -> None:
    # Arrange
    html = """
    <div class="comment" data-comment-id="1">
      <a class="comment-author">Alice</a>
      <div class="comment-text">A <strong>nested</strong> comment.</div>
      <abbr class="comment-created">Yesterday</abbr>
    </div>
    <a href="/watch/?v=123456&amp;p=2">See more comments</a>
    """

    # Act
    comments, cursor = parse_comments_page(html)

    # Assert
    assert comments == [Comment("1", "Alice", "A nested comment.", 0, "Yesterday")]
    assert cursor == "/watch/?v=123456&p=2"


def test_parse_comments_page_tolerates_void_elements() -> None:
    # Arrange: <br> and <img> never emit end tags and must not corrupt depth.
    html = """
    <div class="comment" data-comment-id="1">
      <a class="comment-author">Alice</a>
      <div class="comment-text">Line one<br>Line two <img src="x.png" alt=""> done.</div>
      <abbr class="comment-created">Yesterday</abbr>
    </div>
    """

    # Act
    comments, cursor = parse_comments_page(html)

    # Assert
    assert comments == [Comment("1", "Alice", "Line one Line two done.", 0, "Yesterday")]
    assert cursor is None


def test_parse_comments_page_tolerates_self_closing_tags() -> None:
    # Arrange: XHTML-style self-closing tags must not corrupt depth either.
    html = """
    <div class="comment" data-comment-id="1">
      <a class="comment-author">Alice</a>
      <div class="comment-text">Before<br/>after <img src="x.png" /> end.</div>
      <abbr class="comment-created">Yesterday</abbr>
    </div>
    """

    # Act
    comments, cursor = parse_comments_page(html)

    # Assert
    assert comments == [Comment("1", "Alice", "Before after end.", 0, "Yesterday")]
    assert cursor is None


@pytest.mark.parametrize(
    ("video_id", "max_pages"),
    [("not-numeric", 1), ("123", 0), ("123", True)],
)
def test_collect_comments_rejects_invalid_input(video_id: str, max_pages: int) -> None:
    # Arrange
    fetcher = SequenceFetcher([])

    # Act and Assert
    with pytest.raises(FacebookParseError):
        collect_comments(video_id, fetcher, max_pages)  # type: ignore[arg-type]


def test_collect_comments_rejects_unsafe_pagination_url() -> None:
    # Arrange
    html = fixture("comments_page_1.html").replace(
        "/watch/?v=123456&amp;p=2&amp;cursor=next-page",
        "https://example.com/comments?page=2",
    )
    fetcher = SequenceFetcher([html])

    # Act and Assert
    with pytest.raises(FacebookParseError, match="Unsafe Facebook pagination URL"):
        collect_comments("123456", fetcher, max_pages=2)  # type: ignore[arg-type]


def test_collect_comments_detects_pagination_cycle() -> None:
    # Arrange
    html = fixture("comments_page_1.html").replace(
        "/watch/?v=123456&amp;p=2&amp;cursor=next-page",
        "/watch/?v=123456",
    )
    fetcher = SequenceFetcher([html])

    # Act and Assert
    with pytest.raises(FacebookParseError, match="pagination cycle"):
        collect_comments("123456", fetcher, max_pages=2)  # type: ignore[arg-type]


def test_collect_comments_propagates_non_auth_http_errors() -> None:
    # Arrange
    fetcher = SequenceFetcher(
        [FacebookHTTPError("HTTP 503", status_code=503, url="https://mbasic.facebook.com/")]
    )

    # Act and Assert
    with pytest.raises(FacebookHTTPError, match="503"):
        collect_comments("123456", fetcher, max_pages=1)  # type: ignore[arg-type]


def test_parse_and_aggregate_reject_invalid_data() -> None:
    # Arrange
    invalid_like_html = """
    <div class="comment" data-comment-id="1">
      <a class="comment-author">Alice</a>
      <div class="comment-text">Text</div>
      <span class="comment-like-count">many likes</span>
      <abbr class="comment-created">Yesterday</abbr>
    </div>
    """

    # Act and Assert
    with pytest.raises(FacebookParseError, match="HTML must be a string"):
        parse_comments_page(None)  # type: ignore[arg-type]
    with pytest.raises(FacebookParseError, match="like count"):
        parse_comments_page(invalid_like_html)
    with pytest.raises(FacebookParseError, match="list of Comment"):
        aggregate_comments((Comment("1", "Alice", "Text", 0, "Now"),))  # type: ignore[arg-type]
