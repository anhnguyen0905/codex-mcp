"""Parsing for localized count strings found in Facebook metadata."""

from decimal import Decimal, InvalidOperation
import re

from fb_crawler.errors import FacebookParseError

COUNT_PATTERN = re.compile(
    r"^(?P<number>\d+(?:[.,]\d+)?)\s*(?P<unit>nghìn|triệu|tỷ|k|m|b)?$",
    re.IGNORECASE,
)
PLAIN_INTEGER_PATTERN = re.compile(r"^\d+$")
GROUPED_INTEGER_PATTERN = re.compile(r"^\d{1,3}(?:[.,]\d{3})+$")
UNIT_MULTIPLIERS = {
    "nghìn": 1_000,
    "k": 1_000,
    "triệu": 1_000_000,
    "m": 1_000_000,
    "tỷ": 1_000_000_000,
    "b": 1_000_000_000,
}


def parse_localized_count(raw_count: str) -> int:
    """Convert a Vietnamese or English localized count to an integer."""
    normalized = _normalize(raw_count)
    if PLAIN_INTEGER_PATTERN.fullmatch(normalized):
        return int(normalized)
    if GROUPED_INTEGER_PATTERN.fullmatch(normalized):
        return int(normalized.replace(".", "").replace(",", ""))

    match = COUNT_PATTERN.fullmatch(normalized)
    if match is None or match.group("unit") is None:
        raise FacebookParseError(f"Invalid localized count: {raw_count!r}")

    number = match.group("number").replace(",", ".")
    unit = match.group("unit").lower()
    try:
        value = Decimal(number) * UNIT_MULTIPLIERS[unit]
    except (InvalidOperation, KeyError) as exc:
        raise FacebookParseError(f"Invalid localized count: {raw_count!r}") from exc
    if value != value.to_integral_value():
        raise FacebookParseError(f"Count does not resolve to an integer: {raw_count!r}")
    return int(value)


def _normalize(raw_count: str) -> str:
    if not isinstance(raw_count, str):
        raise FacebookParseError("Localized count must be a string")
    normalized = " ".join(raw_count.replace("\xa0", " ").split()).strip()
    if not normalized:
        raise FacebookParseError("Localized count cannot be empty")
    return normalized

