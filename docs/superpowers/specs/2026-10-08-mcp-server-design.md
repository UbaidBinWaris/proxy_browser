# MCP server — design (Phase 1c)

Status: draft for review · 2026-10-08

## Goal

Let AI coding assistants such as Claude Code, Copilot or Cursor run geo- and
device-aware QA checks through the Model Context Protocol. Example prompt: "open
staging.example.com on an iPhone 15 in WebKit from Austin, TX, submit the form
with synthetic data and tell me what broke." The assistant gets structured
results and screenshots back.

Success:
- An assistant can list engines, devices and locations; verify an exit IP; run
  an ad-hoc check or an exported suite; and read the results.
- The assistant can only reach origins the human operator allowlisted. It can
  never read credentials, and it is bounded by case, concurrency and daily
  budgets.
- No network listener. The server speaks MCP over stdio only.

## Approach

| Option | What it is | Verdict |
|---|---|---|
| **A. Headless stdio server** on the CLI runtime | Reuses the CI runner: credentials come from env, no desktop vault, fresh contexts | **Recommended first.** Smallest attack surface; works locally, in Docker and in CI. |
| B. Bridge into the running desktop app | Local socket into the Electron app; uses the vault, installed browsers and site access tokens | Later, as a separate spec. Any local process holding the pairing secret could drive browsers that have proxy credentials, so it needs pairing, consent prompts and a kill switch. |

This spec covers **A**.

## Non-goals

- Controlling the desktop app or its open sessions (option B).
- Arbitrary JavaScript, file uploads or downloads requested by the assistant.
- Any origin the operator did not allowlist. Any anti-bot evasion (see the
  CONTRIBUTING.md scope).
- Remote transports (HTTP/SSE). stdio only.

## Design

### Module layout (`src/main/mcp/`)

| File | Role |
|---|---|
| `server.ts` | Builds the MCP server (`@modelcontextprotocol/sdk`, exact version pinned) on a stdio transport. Logs go to stderr only. |
| `policy.ts` | Pure: parses `QA_MCP_*` settings, checks the origin allowlist and enforces budgets. |
| `tools/*.ts` | One file per tool, each a pure handler `(input, deps) → result` with a Zod input schema. |
| `deps.ts` | Adapter onto the existing headless runtime used by `qa/cli.ts`: provisioner, proxy manager with the provider registry, executor, reports. No Electron imports. |

It builds as a third main-process entry, `out/main/qa-mcp.js`, next to
`qa-cli`. The Docker runner gets an `--mcp` mode (`docker run -i … --mcp`).

### Tools

| Tool | Input | Output |
|---|---|---|
| `list_capabilities` | – | Installed engines with versions, configured providers and products (from env), target modes, limits in force |
| `search_devices` | `query`, `limit≤20` | Device presets: id, name, viewport, engine compatibility |
| `search_locations` | `query`, `limit≤20` | US state, city and ZIP entries from the bundled GeoNames data |
| `check_exit_ip` | `provider?`, `product?`, `target?` | Verified exit IP, geolocation and match verdict. Counts against the budget. |
| `run_check` | `url`, `engines[]`, `devices[]`, `targets[]?`, `steps[]?`, `healing?` | Per-case status, failed steps, console errors, failed requests, exit IP and match, healed steps, plus up to 4 screenshots as MCP image content (downscaled, masked as usual) |
| `run_manifest` | `path` (inside `QA_MCP_WORKSPACE`), `environment?`, `healing?` | Same summary for an exported scenario or suite |
| `get_results` | `runId` | The stored summary of an earlier run in this server process |

`steps` use the existing scenario step schema (`src/shared/qa.ts`). No new
action types are added.

### Policy (the part that matters most)

| Setting | Required | Default | Effect |
|---|---|---|---|
| `QA_MCP_ALLOWED_ORIGINS` | **yes** | – | Comma-separated https origins (http only for localhost). The server refuses to start without it. Every `run_check` URL and every scenario's approved origins must be a subset. |
| `QA_MCP_WORKSPACE` | for `run_manifest` | – | Directory that manifests and baselines must resolve inside (real-path check, no symlink escape). |
| `QA_MCP_MAX_CASES` | no | 12 | Maximum cases per tool call |
| `QA_MCP_CONCURRENCY` | no | 2 | Concurrent browsers (1–4) |
| `QA_MCP_DAILY_BUDGET` | no | 200 | Case attempts per UTC day, persisted in a small state file under `QA_MCP_WORKSPACE`, or in memory when it is not set |

Additional rules:
- Proxy credentials come from the same environment variables as the CLI and are
  removed from `process.env` before browsers launch.
- Tool outputs pass through the existing log and evidence redactors.
  Credentials, `Proxy-Authorization` headers and dataset values never appear in
  results.
- Every tool call is written to stderr as an audit line containing the tool
  name, origins, case count and outcome, never values.
- Document navigation follows the existing origin isolation, and the
  navigation guard applies unchanged.

### Client setup (documented)

```json
{
  "mcpServers": {
    "proxy-qa": {
      "command": "node",
      "args": ["/path/to/proxy_browser/out/main/qa-mcp.js"],
      "env": {
        "QA_MCP_ALLOWED_ORIGINS": "https://staging.example.com",
        "QA_PROVIDER": "dataimpulse",
        "QA_PROVIDER_USERNAME": "…",
        "QA_PROVIDER_PASSWORD": "…"
      }
    }
  }
}
```

## Error handling

Tool errors are returned as MCP tool errors (`isError: true`) with the existing
`AppError` code and message. Examples: origin not allowlisted, budget exhausted,
engine not installed, location mismatch after re-rolls, invalid step. Protocol
or transport failures exit the process with a non-zero code. Cancellation from
the client aborts active cases through the existing `AbortSignal` path.

## Testing

- `policy.ts`: allowlist parsing and normalisation, subset checks, workspace
  real-path containment (symlink escape refused), and budget arithmetic across
  UTC days.
- Each tool handler with fake dependencies: input validation, limits, and
  redaction (a planted secret never appears in output).
- A protocol test using the SDK's in-memory client/server transport: tool
  listing, schema exposure, and the error shape for a refused origin.
- A real-Chromium test: `run_check` against a local page on an allowlisted
  `127.0.0.1` origin passes, and a non-allowlisted origin is refused before any
  browser starts.
- A build check that `out/main/qa-mcp.js` has no Electron import (same check as
  `qa-cli`).

## Dependencies

- `@modelcontextprotocol/sdk` (1.32.1 at time of writing, exact pin). This is
  the only new runtime dependency.

## Open questions

1. Should `run_check` allow submit-type steps (click on a submit button) by
   default? Submitting creates real records on the staging site. Proposal:
   allowed, because the origins are the operator's own staging hosts, and
   documented together with the site access token guidance on tagging test
   submissions.
2. Should option B (desktop bridge) be specced next, or wait for feedback from
   using option A?
