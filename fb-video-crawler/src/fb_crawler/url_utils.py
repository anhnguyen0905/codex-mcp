"""Validation and normalization helpers for Facebook video URLs."""

import re
from urllib.parse import parse_qs, urlsplit

from fb_crawler.errors import FacebookParseError

FACEBOOK_HOST_PATTERN = re.compile(r"(^|\.)facebook\.com$", re.IGNORECASE)
PATH_VIDEO_ID_PATTERN = re.compile(r"/(?:videos|reel)/(\d+)(?:/|$)")
NUMERIC_ID_PATTERN = re.compile(r"^\d+$")
CANONICAL_VIDEO_URL = "https://www.facebook.com/watch/?v={video_id}"


def extract_video_id(url: str) -> str:
    """Extract a numeric video id from a supported Facebook URL."""
    if not isinstance(url, str) or not url.strip():
        raise FacebookParseError("Facebook video URL must be a non-empty string")

    parsed = urlsplit(url.strip())
    if parsed.scheme not in {"http", "https"} or not _is_facebook_host(parsed.hostname):
        raise FacebookParseError(f"Not a valid Facebook URL: {url!r}")

    path_match = PATH_VIDEO_ID_PATTERN.search(parsed.path)
    if path_match is not None:
        return path_match.group(1)

    query_video_ids = parse_qs(parsed.query).get("v", [])
    if parsed.path.rstrip("/") == "/watch" and query_video_ids:
        candidate = query_video_ids[0]
        if NUMERIC_ID_PATTERN.fullmatch(candidate):
            return candidate
    raise FacebookParseError(f"No numeric video id found in URL: {url!r}")


def canonical_video_url(video_id_or_url: str) -> str:
    """Return the canonical Facebook watch URL for an id or supported URL."""
    if not isinstance(video_id_or_url, str) or not video_id_or_url.strip():
        raise FacebookParseError("Video id or URL must be a non-empty string")
    candidate = video_id_or_url.strip()
    video_id = candidate if NUMERIC_ID_PATTERN.fullmatch(candidate) else extract_video_id(candidate)
    return CANONICAL_VIDEO_URL.format(video_id=video_id)


def _is_facebook_host(hostname: str | None) -> bool:
    return hostname is not None and FACEBOOK_HOST_PATTERN.search(hostname) is not None

