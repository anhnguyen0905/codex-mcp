"""JSON and CSV output for immutable crawler results."""

from collections.abc import Callable
import csv
from dataclasses import asdict
import json
import os
from pathlib import Path
import tempfile
from typing import IO

from fb_crawler.comments import Comment
from fb_crawler.errors import FacebookParseError
from fb_crawler.metrics import VideoMetrics

COMMENTS_CSV_FIELDS = (
    "comment_id",
    "author",
    "text",
    "like_count",
    "created_time",
)
# Leading characters that spreadsheet applications interpret as formulas.
CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def write_metrics_json(metrics: VideoMetrics, path: str | Path) -> None:
    """Atomically write metrics as readable UTF-8 JSON."""
    if not isinstance(metrics, VideoMetrics):
        raise FacebookParseError("metrics must be a VideoMetrics object")
    output_path = _validated_path(path)
    payload = asdict(metrics)

    def write_payload(stream: IO[str]) -> None:
        stream.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

    _write_atomic(output_path, write_payload)


def write_comments_csv(comments: list[Comment], path: str | Path) -> None:
    """Atomically write comments as UTF-8 CSV with formula-injection protection."""
    if not isinstance(comments, list) or any(not isinstance(item, Comment) for item in comments):
        raise FacebookParseError("comments must be a list of Comment objects")
    output_path = _validated_path(path)
    rows = [_sanitized_row(asdict(comment)) for comment in comments]

    def write_rows(stream: IO[str]) -> None:
        writer = csv.DictWriter(stream, fieldnames=COMMENTS_CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)

    _write_atomic(output_path, write_rows)


def _write_atomic(path: Path, write_content: Callable[[IO[str]], None]) -> None:
    """Write via a same-directory temp file, then atomically replace the target."""
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        newline="",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    )
    try:
        with handle as stream:
            write_content(stream)
        os.replace(handle.name, path)
    except BaseException:
        Path(handle.name).unlink(missing_ok=True)
        raise


def _sanitized_row(row: dict[str, object]) -> dict[str, object]:
    return {name: _sanitized_cell(value) for name, value in row.items()}


def _sanitized_cell(value: object) -> object:
    if isinstance(value, str) and value.startswith(CSV_FORMULA_PREFIXES):
        return f"'{value}"
    return value


def _validated_path(path: str | Path) -> Path:
    if not isinstance(path, (str, Path)) or not str(path).strip():
        raise FacebookParseError("Output path must be a non-empty path")
    return Path(path)
