"""Tests for metrics JSON and comments CSV exports."""

import csv
from dataclasses import replace
import json

import pytest

from fb_crawler.comments import Comment
from fb_crawler.errors import FacebookParseError
from fb_crawler.export import write_comments_csv, write_metrics_json
from fb_crawler.metrics import VideoMetrics


def sample_metrics() -> VideoMetrics:
    return VideoMetrics(
        video_id="123",
        url="https://www.facebook.com/reel/123/",
        title="Example video",
        description="Example description",
        view_count=2_800_000,
        reaction_count=1_300,
        comment_count=None,
        share_count=None,
        source="facebook_og_metadata",
        warnings=("comment_count unavailable", "share_count unavailable"),
    )


def test_write_metrics_json_has_expected_shape(tmp_path) -> None:
    # Arrange
    output_path = tmp_path / "metrics.json"

    # Act
    write_metrics_json(sample_metrics(), output_path)

    # Assert
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert list(payload) == [
        "video_id",
        "url",
        "title",
        "description",
        "view_count",
        "reaction_count",
        "comment_count",
        "share_count",
        "source",
        "warnings",
    ]
    assert payload["view_count"] == 2_800_000
    assert payload["comment_count"] is None
    assert payload["warnings"] == [
        "comment_count unavailable",
        "share_count unavailable",
    ]


def test_write_comments_csv_has_utf8_header_and_rows(tmp_path) -> None:
    # Arrange
    comments = [
        Comment("c1", "Chloé Lê", "Works, perfectly.", 5, "1710000900"),
        Comment("c2", "Alice", "Thanks!", 0, "1710001000"),
    ]
    output_path = tmp_path / "comments.csv"

    # Act
    write_comments_csv(comments, output_path)

    # Assert
    with output_path.open(encoding="utf-8", newline="") as csv_file:
        rows = list(csv.DictReader(csv_file))
    assert list(rows[0]) == ["comment_id", "author", "text", "like_count", "created_time"]
    assert rows[0] == {
        "comment_id": "c1",
        "author": "Chloé Lê",
        "text": "Works, perfectly.",
        "like_count": "5",
        "created_time": "1710000900",
    }
    assert len(rows) == 2


def test_write_comments_csv_neutralizes_formula_injection(tmp_path) -> None:
    # Arrange: cells starting with =, +, -, @, tab, or CR are spreadsheet formulas.
    comments = [
        Comment("c1", "@attacker", '=HYPERLINK("http://evil.example","click")', 0, "100"),
        Comment("c2", "Bob", "+1 agreed", 0, "-200"),
        Comment("c3", "Carol", "\t=cmd", 0, "300"),
    ]
    output_path = tmp_path / "comments.csv"

    # Act
    write_comments_csv(comments, output_path)

    # Assert
    with output_path.open(encoding="utf-8", newline="") as csv_file:
        rows = list(csv.DictReader(csv_file))
    assert rows[0]["author"] == "'@attacker"
    assert rows[0]["text"] == "'=HYPERLINK(\"http://evil.example\",\"click\")"
    assert rows[1]["text"] == "'+1 agreed"
    assert rows[1]["created_time"] == "'-200"
    assert rows[2]["text"] == "'\t=cmd"


def test_write_metrics_json_replaces_target_atomically(tmp_path) -> None:
    # Arrange: an existing file must be replaced without leftover temp files.
    output_path = tmp_path / "metrics.json"
    output_path.write_text('{"stale": true}', encoding="utf-8")

    # Act
    write_metrics_json(sample_metrics(), output_path)

    # Assert
    assert json.loads(output_path.read_text(encoding="utf-8"))["video_id"] == "123"
    assert [item.name for item in tmp_path.iterdir()] == ["metrics.json"]


def test_write_metrics_json_failure_preserves_original_file(tmp_path) -> None:
    # Arrange: a non-serializable value makes json.dumps fail mid-write.
    output_path = tmp_path / "metrics.json"
    output_path.write_text('{"original": true}', encoding="utf-8")
    broken_metrics = replace(sample_metrics(), view_count={1, 2})  # type: ignore[arg-type]

    # Act and Assert
    with pytest.raises(TypeError):
        write_metrics_json(broken_metrics, output_path)
    assert output_path.read_text(encoding="utf-8") == '{"original": true}'
    assert [item.name for item in tmp_path.iterdir()] == ["metrics.json"]


def test_write_comments_csv_replaces_target_atomically(tmp_path) -> None:
    # Arrange
    output_path = tmp_path / "comments.csv"
    output_path.write_text("stale", encoding="utf-8")
    comments = [Comment("c1", "Alice", "Hi", 0, "100")]

    # Act
    write_comments_csv(comments, output_path)

    # Assert
    with output_path.open(encoding="utf-8", newline="") as csv_file:
        rows = list(csv.DictReader(csv_file))
    assert rows == [
        {
            "comment_id": "c1",
            "author": "Alice",
            "text": "Hi",
            "like_count": "0",
            "created_time": "100",
        }
    ]
    assert [item.name for item in tmp_path.iterdir()] == ["comments.csv"]


def test_export_rejects_incorrect_data_types(tmp_path) -> None:
    # Arrange, Act, and Assert
    with pytest.raises(FacebookParseError):
        write_metrics_json("not metrics", tmp_path / "metrics.json")  # type: ignore[arg-type]
    with pytest.raises(FacebookParseError):
        write_comments_csv(["not a comment"], tmp_path / "comments.csv")  # type: ignore[list-item]
    with pytest.raises(FacebookParseError):
        write_metrics_json(sample_metrics(), "")
