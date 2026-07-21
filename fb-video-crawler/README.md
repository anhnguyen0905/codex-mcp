# Facebook Video Crawler

A supported Python 3.11+ tool for scraping the public Open Graph metadata exposed by Facebook
video pages. It uses plain HTTP requests through `httpx`; it does not use a login, access token,
Graph API, browser automation, Selenium, or Playwright.

Status: this project is an officially tracked deliverable of this repository. It is tested on
Python 3.11, 3.12, and 3.13 in CI (`.github/workflows/crawler-ci.yml`) with a hard 80% coverage
gate. That said, it depends on the shape of Facebook's public HTML, which can change without
notice — see the limitations section below before relying on it.

## Installation

Create an environment and install the package with its test dependencies:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[dev]'
```

## Metrics

```bash
python -m fb_crawler.cli metrics \
  "https://www.facebook.com/facebook/videos/10153231379946729/" \
  -o metrics.json
```

The JSON contains `video_id`, `url`, `title`, `description`, `view_count`, `reaction_count`,
`comment_count`, `share_count`, `source`, and `warnings`. Counts are parsed from the localized
Open Graph title **by label, never by position**: a segment such as `2K views` or
`2,8 triệu lượt xem` is assigned to `view_count` only because of its label. Supported labels
cover views/plays, reactions/likes, comments, and shares in English and Vietnamese (including
units `nghìn`, `triệu`, `tỷ`, `K`, `M`, `B`). A count whose label is missing or unrecognized is
never guessed — the metric stays `null` and a warning explains why.

`fetch_metrics` also cross-checks the video ID in the requested URL against the ID in the
response's `og:url`. If Facebook serves metadata for a different video (redirects, canonical
swaps), it raises `FacebookVideoMismatchError` instead of silently returning the wrong metrics.

The metrics module can also be invoked independently:

```python
from fb_crawler.export import write_metrics_json
from fb_crawler.http_client import Fetcher
from fb_crawler.metrics import fetch_metrics

with Fetcher() as fetcher:
    metrics = fetch_metrics("https://www.facebook.com/reel/10153231379946729/", fetcher)
write_metrics_json(metrics, "metrics.json")
```

## Comments

```bash
python -m fb_crawler.cli comments \
  "https://www.facebook.com/watch/?v=10153231379946729" \
  -o comments.csv \
  --max-pages 5
```

The CSV columns are `comment_id,author,text,like_count,created_time`. On success, the command
prints a JSON summary (total comment count, unique-author count, top authors) followed by an
honest total line: `N comments` when every available page was fetched, or
`N comments (partial, more available)` when `--max-pages` stopped collection while Facebook still
advertised a next page.

Programmatically, `collect_comments` returns an immutable `CommentCollection` with `items`,
`has_more`, `truncated`, and `stop_reason` (`"exhausted"` or `"max_pages"`), so callers can always
tell a complete collection from a truncated one. A valid page with zero comments returns an
empty, non-truncated collection — it is not treated as an error.

## HTTP safety

- **HTTPS only.** Plain `http://` input URLs are rejected with a clear error
  (`FacebookParseError` at URL validation, `FacebookHTTPError` at the HTTP client); URLs are
  never silently upgraded.
- **Response size limit.** A response larger than `MAX_RESPONSE_BYTES` (5 MB) raises
  `FacebookResponseTooLargeError` instead of being truncated, so parsers never operate on
  silently incomplete HTML.
- **Validated redirects.** Redirects are followed manually: every target must be `https` and
  stay within `facebook.com` domains, otherwise `FacebookRedirectError` names the blocked
  target. At most `MAX_REDIRECTS` (5) hops are followed.
- **Accurate retry errors.** After exhausted retries, the raised `FacebookHTTPError` reflects
  the final attempt's actual failure and includes the attempt count plus a summary of earlier
  failures.

## Export safety

- CSV cells that start with `=`, `+`, `-`, `@`, tab, or carriage return are prefixed with a
  single quote (`'`) so spreadsheet applications do not execute them as formulas.
- JSON and CSV files are written atomically: content goes to a temporary file in the target
  directory and is then renamed over the destination, so a failed write never corrupts or
  truncates an existing output file.

## Honest no-token limitations

Unauthenticated Facebook video HTML reliably exposes the title, description, view count, and
reaction count through Open Graph tags. Comment and share counts appear only when Facebook
includes labeled counts in the Open Graph title; otherwise `comment_count` and `share_count` are
JSON `null` with explanatory warnings. They are never guessed or fabricated.

**Known limitation — comment collection frequently hits auth walls.** Unauthenticated comment
endpoints commonly return HTTP 400, redirect to a login page, or serve a login form instead of
comments. When those signals are detected, the comments command raises
`FacebookAuthRequiredError` with a clear message that a session cookie or token is required.
Expect this to be the norm rather than the exception for live requests; this tool intentionally
provides no login or token flow, so for many videos comments simply cannot be collected. Comment
parsing and pagination are exercised against local mbasic-style HTML fixtures, which is what the
test suite guarantees.

Facebook can also change its public HTML or block requests by network, region, or rate limit.
The HTTP client uses a desktop Chrome user agent, follows validated same-domain redirects,
spaces requests, and retries
transient network/5xx failures, but those measures cannot bypass authentication requirements.

## Tests

Unit tests never access the network. They use the saved real video-page fixture, representative
mbasic comment fixtures, and fake HTTP clients:

```bash
pytest --cov=fb_crawler
```

CI runs the same suite on Python 3.11–3.13 and fails below 80% coverage.
