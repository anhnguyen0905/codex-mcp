"""Command-line entry point for metrics and comment collection."""

import argparse
from collections.abc import Sequence
from dataclasses import asdict
import json
from pathlib import Path
import sys

from fb_crawler.comments import aggregate_comments, collect_comments
from fb_crawler.errors import FacebookError
from fb_crawler.export import write_comments_csv, write_metrics_json
from fb_crawler.http_client import Fetcher
from fb_crawler.metrics import fetch_metrics
from fb_crawler.url_utils import extract_video_id


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""
    parser = argparse.ArgumentParser(
        prog="fb-crawler",
        description="Scrape public Facebook video metadata without a token.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    metrics_parser = subparsers.add_parser("metrics", help="write public metrics as JSON")
    metrics_parser.add_argument("url", help="Facebook watch, video, or reel URL")
    metrics_parser.add_argument("-o", "--output", type=Path, required=True)
    metrics_parser.set_defaults(handler=_run_metrics)

    comments_parser = subparsers.add_parser("comments", help="write comments as CSV")
    comments_parser.add_argument("url", help="Facebook watch, video, or reel URL")
    comments_parser.add_argument("-o", "--output", type=Path, required=True)
    comments_parser.add_argument("--max-pages", type=_positive_integer, default=10)
    comments_parser.set_defaults(handler=_run_comments)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the selected command and return a process exit code."""
    args = build_parser().parse_args(argv)
    try:
        return args.handler(args)
    except FacebookError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


def _run_metrics(args: argparse.Namespace) -> int:
    with Fetcher() as fetcher:
        metrics = fetch_metrics(args.url, fetcher)
    write_metrics_json(metrics, args.output)
    print(f"Wrote metrics to {args.output}")
    return 0


def _run_comments(args: argparse.Namespace) -> int:
    video_id = extract_video_id(args.url)
    with Fetcher() as fetcher:
        collection = collect_comments(video_id, fetcher, args.max_pages)
    comments = list(collection.items)
    write_comments_csv(comments, args.output)
    summary = aggregate_comments(comments)
    print(json.dumps(asdict(summary), ensure_ascii=False))
    print(_format_total(summary.total, collection.truncated))
    return 0


def _format_total(total: int, truncated: bool) -> str:
    if truncated:
        return f"{total} comments (partial, more available)"
    return f"{total} comments"


def _positive_integer(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


if __name__ == "__main__":
    raise SystemExit(main())

