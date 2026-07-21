"""Extract reliable public metrics from Facebook Open Graph metadata."""

from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
import re
from typing import Protocol

from fb_crawler.errors import FacebookParseError, FacebookVideoMismatchError
from fb_crawler.numbers import parse_localized_count
from fb_crawler.url_utils import extract_video_id

METRICS_SOURCE = "facebook_og_metadata"
FACEBOOK_TITLE_SUFFIX = "facebook"
COUNT_PREFIX_PATTERN = re.compile(
    r"^\s*(\d+(?:[.,]\d+)?\s*(?:nghìn|triệu|tỷ|[KMB])?)",
    re.IGNORECASE,
)
UNAVAILABLE_COMMENT_WARNING = (
    "comment_count unavailable: unauthenticated HTML does not expose this value."
)
UNAVAILABLE_SHARE_WARNING = (
    "share_count unavailable: unauthenticated HTML does not expose this value."
)
# Label keywords are matched case-insensitively as substrings of the text that
# follows each count. Counts are NEVER assigned by segment position.
TITLE_METRIC_LABELS: dict[str, tuple[str, ...]] = {
    "view_count": ("lượt xem", "views", "view", "plays", "play"),
    "reaction_count": ("cảm xúc", "lượt thích", "reactions", "reaction", "likes", "like"),
    "comment_count": ("bình luận", "comments", "comment"),
    "share_count": ("chia sẻ", "shares", "share"),
}


@dataclass(frozen=True, slots=True)
class VideoMetrics:
    """Validated metrics parsed from public Facebook Open Graph tags."""

    video_id: str
    url: str
    title: str
    description: str
    view_count: int | None
    reaction_count: int | None
    comment_count: int | None
    share_count: int | None
    source: str
    warnings: tuple[str, ...]


class TextResponse(Protocol):
    """Response shape required by the metrics fetch operation."""

    text: str


class MetricsFetcher(Protocol):
    """Fetcher shape required by the metrics module."""

    def get(self, url: str) -> TextResponse: ...


class OpenGraphParser(HTMLParser):
    """Collect Open Graph meta values without third-party HTML dependencies."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.values: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "meta":
            return
        attributes = {name.lower(): value for name, value in attrs if value is not None}
        property_name = attributes.get("property", "").lower()
        content = attributes.get("content")
        if property_name.startswith("og:") and content is not None:
            self.values.setdefault(property_name, unescape(content).strip())


def parse_metrics(html: str) -> VideoMetrics:
    """Parse a Facebook video page's Open Graph tags into immutable metrics."""
    if not isinstance(html, str) or not html.strip():
        raise FacebookParseError("Facebook video HTML must be a non-empty string")

    parser = OpenGraphParser()
    parser.feed(html)
    og_title = _required_meta(parser.values, "og:title")
    og_url = _required_meta(parser.values, "og:url")
    description = _required_meta(parser.values, "og:description")
    video_id = extract_video_id(og_url)

    counts, count_warnings = _parse_title_counts(og_title)
    title = _extract_content_title(og_title)
    warnings: list[str] = []
    if counts["comment_count"] is None:
        warnings.append(UNAVAILABLE_COMMENT_WARNING)
    if counts["share_count"] is None:
        warnings.append(UNAVAILABLE_SHARE_WARNING)
    warnings.extend(count_warnings)
    return VideoMetrics(
        video_id=video_id,
        url=og_url,
        title=title,
        description=description,
        view_count=counts["view_count"],
        reaction_count=counts["reaction_count"],
        comment_count=counts["comment_count"],
        share_count=counts["share_count"],
        source=METRICS_SOURCE,
        warnings=tuple(warnings),
    )


def fetch_metrics(url: str, fetcher: MetricsFetcher) -> VideoMetrics:
    """Fetch and parse public Facebook video metrics for the requested video only."""
    requested_video_id = extract_video_id(url)
    response = fetcher.get(url)
    metrics = parse_metrics(response.text)
    if metrics.video_id != requested_video_id:
        raise FacebookVideoMismatchError(
            f"Requested video {requested_video_id} but the response metadata "
            f"references video {metrics.video_id}"
        )
    return metrics


def _required_meta(values: dict[str, str], property_name: str) -> str:
    value = values.get(property_name, "").strip()
    if value:
        return value
    raise FacebookParseError(f"Missing required {property_name} metadata")


def _parse_title_counts(title: str) -> tuple[dict[str, int | None], tuple[str, ...]]:
    """Assign og:title counts to metrics by their labels, never by position."""
    counts: dict[str, int | None] = {field: None for field in TITLE_METRIC_LABELS}
    warnings: list[str] = []
    metric_segment = title.split("|", maxsplit=1)[0]
    for part in (segment.strip() for segment in metric_segment.split("·")):
        match = COUNT_PREFIX_PATTERN.match(part)
        if match is None:
            continue
        count = _parse_count(match.group(1))
        if count is None:
            continue
        field = _match_metric_field(part[match.end():].strip().casefold())
        if field is None:
            warnings.append(
                f"Ignored og:title segment {part!r}: no recognized metric label; "
                "the count was not assigned to any metric."
            )
        elif counts[field] is None:
            counts[field] = count
    if counts["view_count"] is None:
        warnings.append("view_count unavailable: og:title did not contain a parseable value.")
    if counts["reaction_count"] is None:
        warnings.append("reaction_count unavailable: og:title did not contain a parseable value.")
    return counts, tuple(warnings)


def _match_metric_field(label: str) -> str | None:
    if not label:
        return None
    for field, keywords in TITLE_METRIC_LABELS.items():
        if any(keyword in label for keyword in keywords):
            return field
    return None


def _parse_count(text: str) -> int | None:
    try:
        return parse_localized_count(text)
    except FacebookParseError:
        return None


def _extract_content_title(og_title: str) -> str:
    segments = [segment.strip() for segment in og_title.split("|") if segment.strip()]
    if segments and segments[-1].casefold() == FACEBOOK_TITLE_SUFFIX:
        segments = segments[:-1]
    if segments and "·" in segments[0]:
        if len(segments) >= 2:
            return " | ".join(segments[1:])
        raise FacebookParseError("og:title did not contain a video title")
    if segments:
        return " | ".join(segments)
    raise FacebookParseError("og:title did not contain a usable title")
