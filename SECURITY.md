# Security policy

## Supported versions

Only the latest published version of `@anhnguyen0905/codex-mcp` / the `codex-flow` plugin receives
fixes. Update with `npm i -g @anhnguyen0905/codex-mcp@latest` or `/plugin update codex-flow`.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability
reporting on https://github.com/anhnguyen0905/codex-mcp/security/advisories/new. You will get an
acknowledgement within 7 days and a fix or mitigation plan within 30 days for confirmed issues.

## Threat model in one paragraph

The MCP server spawns the local `codex` CLI and `git`; it makes no network calls of its own, stores
no credentials, and writes only to the project's gitignored `.codex-flow/` directory and to
`~/.codex-mcp/` (metrics, lock files). Inputs from the MCP client (prompts, cwd, refs, model names,
`verifyCommand`) are validated at the schema boundary: absolute cwd, no leading-dash argv values,
git-ref pattern, byte caps on prompts and outputs. Codex output, `verifyCommand` output, and
third-party skills are untrusted content; the `/codex-flow` workflow treats them as evidence to be
verified, never as instructions.
