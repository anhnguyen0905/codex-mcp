"""Tests for localized Facebook count parsing."""

import pytest

from fb_crawler.errors import FacebookParseError
from fb_crawler.numbers import parse_localized_count


@pytest.mark.parametrize(
    ("raw_count", "expected"),
    [
        ("2,8 triệu", 2_800_000),
        ("1,3K", 1_300),
        ("3.4M", 3_400_000),
        ("1.234", 1_234),
        ("5 nghìn", 5_000),
        ("12", 12),
        ("2 tỷ", 2_000_000_000),
        ("1 B", 1_000_000_000),
        ("1.234.567", 1_234_567),
        ("2\xa0triệu", 2_000_000),
    ],
)
def test_parse_localized_count(raw_count: str, expected: int) -> None:
    # Arrange and Act
    result = parse_localized_count(raw_count)

    # Assert
    assert result == expected


@pytest.mark.parametrize(
    "raw_count",
    ["garbage", "", "-1K", "12 cats", "0.0001K", None],
)
def test_parse_localized_count_rejects_invalid_input(raw_count: str | None) -> None:
    # Arrange, Act, and Assert
    with pytest.raises(FacebookParseError):
        parse_localized_count(raw_count)  # type: ignore[arg-type]
