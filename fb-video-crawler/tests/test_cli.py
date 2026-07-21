"""Tests for command-line wiring without network access."""

import csv
import json

import pytest

from fb_crawler import cli
from fb_crawler.comments import Comment, CommentCollection
from fb_crawler.errors import FacebookAuthRequiredError
from fb_crawler.metrics import VideoMetrics


class FakeFetcher:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        return None


def sample_metrics() -> VideoMetrics:
    return VideoMetrics(
        video_id="123",
        url="https://www.facebook.com/reel/123/",
        title="Example",
        description="Description",
        view_count=10,
        reaction_count=2,
        comment_count=None,
        share_count=None,
        source="facebook_og_metadata",
        warnings=("comment_count unavailable", "share_count unavailable"),
    )


def test_metrics_command_writes_json(monkeypatch, tmp_path, capsys) -> None:
    # Arrange
    output_path = tmp_path / "metrics.json"
    monkeypatch.setattr(cli, "Fetcher", FakeFetcher)
    monkeypatch.setattr(cli, "fetch_metrics", lambda url, fetcher: sample_metrics())

    # Act
    exit_code = cli.main(
        ["metrics", "https://www.facebook.com/reel/123/", "-o", str(output_path)]
    )

    # Assert
    assert exit_code == 0
    assert json.loads(output_path.read_text(encoding="utf-8"))["video_id"] == "123"
    assert "Wrote metrics" in capsys.readouterr().out


def test_comments_command_writes_csv_and_prints_summary(
    monkeypatch,
    tmp_path,
    capsys,
) -> None:
    # Arrange
    output_path = tmp_path / "comments.csv"
    collection = CommentCollection(
        items=(
            Comment("1", "Alice", "One", 0, "100"),
            Comment("2", "Alice", "Two", 1, "200"),
        ),
        has_more=False,
        truncated=False,
        stop_reason="exhausted",
    )
    monkeypatch.setattr(cli, "Fetcher", FakeFetcher)
    monkeypatch.setattr(cli, "collect_comments", lambda video_id, fetcher, pages: collection)

    # Act
    exit_code = cli.main(
        [
            "comments",
            "https://www.facebook.com/watch/?v=123",
            "-o",
            str(output_path),
            "--max-pages",
            "2",
        ]
    )

    # Assert
    assert exit_code == 0
    with output_path.open(encoding="utf-8", newline="") as csv_file:
        assert len(list(csv.DictReader(csv_file))) == 2
    output_lines = capsys.readouterr().out.strip().splitlines()
    summary = json.loads(output_lines[0])
    assert summary == {
        "total": 2,
        "unique_authors": 1,
        "top_authors": [["Alice", 2]],
    }
    assert output_lines[1] == "2 comments"


def test_comments_command_reports_partial_results(monkeypatch, tmp_path, capsys) -> None:
    # Arrange: max_pages truncated the collection while more pages remained.
    output_path = tmp_path / "comments.csv"
    collection = CommentCollection(
        items=(Comment("1", "Alice", "One", 0, "100"),),
        has_more=True,
        truncated=True,
        stop_reason="max_pages",
    )
    monkeypatch.setattr(cli, "Fetcher", FakeFetcher)
    monkeypatch.setattr(cli, "collect_comments", lambda video_id, fetcher, pages: collection)

    # Act
    exit_code = cli.main(
        [
            "comments",
            "https://www.facebook.com/watch/?v=123",
            "-o",
            str(output_path),
        ]
    )

    # Assert
    assert exit_code == 0
    output_lines = capsys.readouterr().out.strip().splitlines()
    assert output_lines[1] == "1 comments (partial, more available)"


def test_cli_reports_domain_errors(monkeypatch, tmp_path, capsys) -> None:
    # Arrange
    output_path = tmp_path / "metrics.json"
    monkeypatch.setattr(cli, "Fetcher", FakeFetcher)

    def raise_auth_error(url, fetcher):
        raise FacebookAuthRequiredError("authentication required")

    monkeypatch.setattr(cli, "fetch_metrics", raise_auth_error)

    # Act
    exit_code = cli.main(
        ["metrics", "https://www.facebook.com/reel/123/", "-o", str(output_path)]
    )

    # Assert
    assert exit_code == 1
    assert "authentication required" in capsys.readouterr().err
    assert not output_path.exists()


@pytest.mark.parametrize("value", ["0", "-1", "not-a-number"])
def test_comments_command_rejects_invalid_max_pages(value: str) -> None:
    # Arrange
    parser = cli.build_parser()

    # Act and Assert
    with pytest.raises(SystemExit):
        parser.parse_args(
            [
                "comments",
                "https://www.facebook.com/watch/?v=123",
                "-o",
                "comments.csv",
                "--max-pages",
                value,
            ]
        )
