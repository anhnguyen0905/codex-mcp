"""Parse, collect, and aggregate mbasic-style Facebook comments."""

from collections import Counter
from dataclasses import dataclass
from html.parser import HTMLParser
import re
from typing import Protocol
from urllib.parse import urljoin, urlsplit

from fb_crawler.errors import (
    FacebookAuthRequiredError,
    FacebookHTTPError,
    FacebookParseError,
)
from fb_crawler.numbers import parse_localized_count

MBASIC_COMMENTS_URL = "https://mbasic.facebook.com/watch/?v={video_id}"
VIDEO_ID_PATTERN = re.compile(r"^\d+$")
COUNT_PREFIX_PATTERN = re.compile(
    r"^\s*(\d+(?:[.,]\d+)?\s*(?:nghìn|triệu|tỷ|[KMB])?)",
    re.IGNORECASE,
)
AUTH_REQUIRED_MESSAGE = (
    "Facebook comment collection requires authentication; provide a session cookie or token."
)
TOP_AUTHOR_LIMIT = 5
# HTML void elements never emit end tags and must not affect the tag stack.
VOID_ELEMENTS = frozenset(
    {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "source",
        "track",
        "wbr",
    }
)
STOP_REASON_EXHAUSTED = "exhausted"
STOP_REASON_MAX_PAGES = "max_pages"


@dataclass(frozen=True, slots=True)
class Comment:
    """One validated Facebook comment."""

    comment_id: str
    author: str
    text: str
    like_count: int
    created_time: str


@dataclass(frozen=True, slots=True)
class CommentCollection:
    """Immutable result of a comment collection run, honest about partiality."""

    items: tuple[Comment, ...]
    has_more: bool
    truncated: bool
    stop_reason: str


@dataclass(frozen=True, slots=True)
class CommentSummary:
    """Small immutable aggregation of collected comments."""

    total: int
    unique_authors: int
    top_authors: tuple[tuple[str, int], ...]


class CommentsResponse(Protocol):
    """Response shape required by comment collection."""

    status_code: int
    headers: object
    text: str
    url: object


class CommentsFetcher(Protocol):
    """Fetcher shape required by the comments module."""

    def get(self, url: str) -> CommentsResponse: ...


class CommentsPageParser(HTMLParser):
    """Parse the stable semantic pieces of an mbasic-style comments page."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.comments: list[Comment] = []
        self.next_cursor: str | None = None
        self._tag_stack: list[str] = []
        self._capture_history: list[str | None] = []
        self._capture: str | None = None
        self._comment_root_depth: int | None = None
        self._current: dict[str, str | list[str]] | None = None
        self._anchor: dict[str, str | list[str]] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in VOID_ELEMENTS:
            return
        attributes = {name.lower(): value for name, value in attrs if value is not None}
        classes = set(attributes.get("class", "").split())
        self._capture_history.append(self._capture)
        depth = len(self._tag_stack)
        self._tag_stack.append(tag.lower())

        comment_id = attributes.get("data-comment-id", "").strip()
        if tag.lower() == "div" and "comment" in classes and comment_id:
            if self._current is not None:
                raise FacebookParseError("Nested comment nodes are not supported")
            self._current = _new_comment_values(comment_id)
            self._comment_root_depth = depth

        if self._current is not None:
            self._set_comment_capture(classes, attributes)
        if tag.lower() == "a":
            self._anchor = {
                "href": attributes.get("href", ""),
                "class": " ".join(classes),
                "text": [],
            }

    def handle_data(self, data: str) -> None:
        if self._current is not None and self._capture is not None:
            values = self._current[self._capture]
            if isinstance(values, list):
                values.append(data)
        if self._anchor is not None:
            text_parts = self._anchor["text"]
            if isinstance(text_parts, list):
                text_parts.append(data)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        """Self-closing tags contribute no depth, captures, or end-tag events."""
        del tag, attrs

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in VOID_ELEMENTS:
            return
        current_depth = len(self._tag_stack) - 1
        if tag.lower() == "a" and self._anchor is not None:
            self._finish_anchor()
        if (
            self._current is not None
            and self._comment_root_depth == current_depth
            and tag.lower() == "div"
        ):
            self.comments.append(_build_comment(self._current))
            self._current = None
            self._comment_root_depth = None

        if self._tag_stack:
            self._tag_stack.pop()
        self._capture = self._capture_history.pop() if self._capture_history else None

    def close(self) -> None:
        super().close()
        if self._current is not None:
            raise FacebookParseError("Unclosed Facebook comment node")

    def _set_comment_capture(
        self,
        classes: set[str],
        attributes: dict[str, str],
    ) -> None:
        field_by_class = {
            "comment-author": "author",
            "comment-text": "text",
            "comment-like-count": "like_count",
            "comment-created": "created_time",
        }
        for class_name, field_name in field_by_class.items():
            if class_name in classes:
                self._capture = field_name
                break
        if "comment-created" in classes and attributes.get("data-utime", "").strip():
            assert self._current is not None
            self._current["created_time"] = [attributes["data-utime"].strip()]
            self._capture = None

    def _finish_anchor(self) -> None:
        assert self._anchor is not None
        href = str(self._anchor["href"]).strip()
        classes = set(str(self._anchor["class"]).split())
        text_parts = self._anchor["text"]
        text = _normalize_text(" ".join(text_parts if isinstance(text_parts, list) else []))
        is_more_link = "see-more-comments" in classes or "see more comments" in text.casefold()
        if is_more_link and href:
            self.next_cursor = href
        self._anchor = None


def parse_comments_page(html: str) -> tuple[list[Comment], str | None]:
    """Parse comments and a next-page link from mbasic-style HTML."""
    if not isinstance(html, str):
        raise FacebookParseError("Comments HTML must be a string")
    parser = CommentsPageParser()
    parser.feed(html)
    parser.close()
    return list(parser.comments), parser.next_cursor


def collect_comments(
    video_id: str,
    fetcher: CommentsFetcher,
    max_pages: int = 10,
) -> CommentCollection:
    """Collect and deduplicate comment pages, or clearly report an auth wall.

    Auth walls are detected from explicit signals (login redirects, login form
    markers, HTTP 400, empty response bodies); a valid page that simply has no
    comments yields an empty, non-truncated collection. When ``max_pages`` runs
    out while a next-page cursor remains, the result is marked truncated.
    """
    _validate_collection_input(video_id, max_pages)
    page_url = MBASIC_COMMENTS_URL.format(video_id=video_id)
    visited_urls: set[str] = set()
    comments_by_id: dict[str, Comment] = {}
    next_cursor: str | None = None

    for _ in range(max_pages):
        if page_url in visited_urls:
            raise FacebookParseError(f"Comment pagination cycle detected at {page_url}")
        visited_urls.add(page_url)
        response = _fetch_comments_page(fetcher, page_url)
        page_comments, next_cursor = parse_comments_page(response.text)
        comments_by_id.update(
            (comment.comment_id, comment)
            for comment in page_comments
            if comment.comment_id not in comments_by_id
        )
        if next_cursor is None:
            break
        page_url = _resolve_next_url(page_url, next_cursor)

    has_more = next_cursor is not None
    return CommentCollection(
        items=tuple(comments_by_id.values()),
        has_more=has_more,
        truncated=has_more,
        stop_reason=STOP_REASON_MAX_PAGES if has_more else STOP_REASON_EXHAUSTED,
    )


def aggregate_comments(comments: list[Comment]) -> CommentSummary:
    """Summarize total comments and the most frequent authors."""
    if not isinstance(comments, list) or any(not isinstance(item, Comment) for item in comments):
        raise FacebookParseError("comments must be a list of Comment objects")
    author_counts = Counter(comment.author for comment in comments)
    ranked_authors = sorted(
        author_counts.items(),
        key=lambda item: (-item[1], item[0].casefold()),
    )
    return CommentSummary(
        total=len(comments),
        unique_authors=len(author_counts),
        top_authors=tuple(ranked_authors[:TOP_AUTHOR_LIMIT]),
    )


def _fetch_comments_page(fetcher: CommentsFetcher, page_url: str) -> CommentsResponse:
    try:
        response = fetcher.get(page_url)
    except FacebookHTTPError as exc:
        if exc.status_code in {400, 401, 403} or _is_login_url(exc.url):
            raise FacebookAuthRequiredError(AUTH_REQUIRED_MESSAGE) from exc
        raise
    if _is_auth_wall_response(response):
        raise FacebookAuthRequiredError(AUTH_REQUIRED_MESSAGE)
    return response


def _is_auth_wall_response(response: CommentsResponse) -> bool:
    headers = response.headers
    location = headers.get("location", "") if hasattr(headers, "get") else ""
    response_url = str(response.url)
    html = response.text
    return (
        response.status_code == 400
        or (300 <= response.status_code < 400 and _is_login_url(location))
        or _is_login_url(response_url)
        or not html.strip()
        or 'id="login_form"' in html
        or "login_form" in html and "password" in html.casefold()
    )


def _is_login_url(url: str | None) -> bool:
    return bool(url and "/login" in urlsplit(urljoin("https://facebook.com", url)).path.casefold())


def _resolve_next_url(current_url: str, next_cursor: str) -> str:
    resolved = urljoin(current_url, next_cursor)
    parsed = urlsplit(resolved)
    hostname = parsed.hostname or ""
    if parsed.scheme != "https" or not (hostname == "facebook.com" or hostname.endswith(".facebook.com")):
        raise FacebookParseError(f"Unsafe Facebook pagination URL: {next_cursor!r}")
    return resolved


def _validate_collection_input(video_id: str, max_pages: int) -> None:
    if not isinstance(video_id, str) or VIDEO_ID_PATTERN.fullmatch(video_id) is None:
        raise FacebookParseError("video_id must contain only digits")
    if not isinstance(max_pages, int) or isinstance(max_pages, bool) or max_pages <= 0:
        raise FacebookParseError("max_pages must be a positive integer")


def _new_comment_values(comment_id: str) -> dict[str, str | list[str]]:
    return {
        "comment_id": comment_id,
        "author": [],
        "text": [],
        "like_count": [],
        "created_time": [],
    }


def _build_comment(values: dict[str, str | list[str]]) -> Comment:
    comment_id = str(values["comment_id"]).strip()
    author = _joined_field(values["author"])
    text = _joined_field(values["text"])
    created_time = _joined_field(values["created_time"])
    if not all((comment_id, author, text, created_time)):
        raise FacebookParseError(f"Comment {comment_id!r} is missing required fields")
    return Comment(
        comment_id=comment_id,
        author=author,
        text=text,
        like_count=_parse_like_count(_joined_field(values["like_count"])),
        created_time=created_time,
    )


def _parse_like_count(text: str) -> int:
    if not text:
        return 0
    match = COUNT_PREFIX_PATTERN.match(text)
    if match is None:
        raise FacebookParseError(f"Invalid comment like count: {text!r}")
    return parse_localized_count(match.group(1))


def _joined_field(value: str | list[str]) -> str:
    return _normalize_text(" ".join(value) if isinstance(value, list) else value)


def _normalize_text(value: str) -> str:
    return " ".join(value.replace("\xa0", " ").split()).strip()
