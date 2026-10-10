# MCP server

The `qa-mcp` server lets AI coding assistants such as Claude Code or Cursor run geo- and device-aware QA checks on origins you allowlist, through the Model Context Protocol.

## What it does

`qa-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server on the same headless runtime as the [CI runner](/docs/ci-runner), so Claude Code, Cursor or another MCP client can run browser tests on your allowlisted origins. You can ask an assistant, for example, "open staging.example.com on an iPhone 15 in WebKit from Austin, TX, submit the form with synthetic data and tell me what broke." The assistant gets a structured result and up to four masked screenshots back.

- **stdio only.** The server opens no network port. Protocol messages use stdout; logs and audit lines go to stderr.
- **Navigation limited to allowlisted origins.** The server does not start without `QA_MCP_ALLOWED_ORIGINS`, and the assistant cannot navigate to any other origin. The page's own scripts, images and API calls can still reach other origins; this is a navigation boundary, not a network firewall.
- **No credentials for the assistant.** Proxy credentials come from the server's environment, are removed from it before a browser starts, and are redacted from every result.
- **Bounded.** Each call has a case limit, concurrent browsers are capped, and each UTC day has a budget of case attempts.

Use it only on sites you own or are contracted to test, preferably staging environments. See [Responsible use](/docs/introduction#responsible-use). The full reference is in [docs/MCP-SERVER.md](https://github.com/UbaidBinWaris/proxy_browser/blob/main/docs/MCP-SERVER.md).

## Build

The server ships with the source code and the runner image, not with the desktop app.

```bash
npm ci
npm run build                 # emits out/main/qa-mcp.js
npm run browsers:install      # Chromium, Firefox and WebKit, if not installed yet
```

It needs Node.js 22.13 or later and runs under plain Node, not Electron. Check that it refuses to start without an allowlist:

```bash
node out/main/qa-mcp.js
# qa-mcp configuration error: QA_MCP_ALLOWED_ORIGINS is required: …   (exit code 2)
```

> **Note:** Start the server with `node` directly, never with `npm run`. npm writes its own banner to stdout, which corrupts the protocol stream.

## Client setup

Every client starts the server as a child process over stdio. Use absolute paths.

### Claude Code

Add the server to the project's `.mcp.json`, or to your user configuration with `claude mcp add`:

```json
{
  "mcpServers": {
    "proxy-qa": {
      "command": "node",
      "args": ["/path/to/proxy_browser/out/main/qa-mcp.js"],
      "env": {
        "QA_MCP_ALLOWED_ORIGINS": "https://staging.example.com",
        "QA_MCP_WORKSPACE": "/path/to/your-app/qa"
      }
    }
  }
}
```

```bash
claude mcp add proxy-qa \
  -e QA_MCP_ALLOWED_ORIGINS=https://staging.example.com \
  -- node /path/to/proxy_browser/out/main/qa-mcp.js
```

Do not commit a `.mcp.json` that contains credentials. Keep proxy credentials in your user configuration or in variables your shell already exports.

### Cursor

Add the same block to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project). Leave the proxy variables out for direct checks, for example against a local development server:

```json
{
  "mcpServers": {
    "proxy-qa": {
      "command": "node",
      "args": ["/path/to/proxy_browser/out/main/qa-mcp.js"],
      "env": {
        "QA_MCP_ALLOWED_ORIGINS": "https://staging.example.com,http://localhost:3000"
      }
    }
  }
}
```

Any other MCP client with stdio support works the same way. The server takes no arguments; configuration comes from environment variables only.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_capabilities` | Installed engines, proxy providers and products with credentials, whether a custom gateway is set, and the limits (allowed origins, cases per call, concurrency, daily budget and attempts left). The assistant should call it first |
| `search_devices` | Find device preset IDs by words (`"iphone 15 pro"`, `"galaxy"`), engine or device type |
| `search_locations` | Search the bundled US dataset (`"austin tx"`, `"new jersey"`, `"78701"`); each entry includes a `target` object for the tools below |
| `check_exit_ip` | Open a sticky proxy session and [verify the exit IP](/use-cases/location-testing), re-rolling up to three times for a target; returns IP, location, ISP and ASN, and the match verdict. Needs proxy credentials. Counts one case attempt |
| `run_check` | Open an allowlisted URL in every engine × device × target combination and run optional steps |
| `run_manifest` | Run a scenario or suite manifest exported from the desktop app, from inside `QA_MCP_WORKSPACE` |
| `get_results` | Return the stored summary of an earlier run in the same server process (the latest 50 runs are kept in memory) |

### `run_check`

| Input | Notes |
| --- | --- |
| `url` | Start URL. Its origin must be allowlisted; URLs with credentials are refused |
| `engines` | 1–10 engine IDs, for example `["chromium", "webkit"]` |
| `devices` | 1–20 preset IDs from `search_devices` |
| `targets` | Up to 20 `target` objects; needs proxy credentials |
| `steps` | 1–100 scenario steps; default: assert that the page body is visible |
| `healing` | `off`, `warn` (default) or `fail` |
| `direct` | Connect without the proxy even when credentials are configured |
| `timeoutMs` | Per-step timeout, 1000–60000 (default 15000) |

Steps use the scenario step schema of the desktop app (see [Scenarios and matrices](/docs/automation#steps)), so they can include checks such as `checkAccessibility` (see [Consent, accessibility and performance checks](/docs/checks)). `goto` steps need absolute URLs on allowlisted origins; variables are only available in manifests. `upload` steps need fixtures embedded in a scenario, so use `run_manifest` for uploads. There is no arbitrary JavaScript and no download, and traces are never captured.

```json
{
  "url": "https://staging.example.com/signup",
  "engines": ["webkit"],
  "devices": ["iphone-15"],
  "targets": [{ "mode": "city", "country": "us", "state": "Texas", "stateCode": "TX", "city": "Austin", "zip": null }],
  "steps": [
    { "action": "fill", "selector": "#email", "value": "qa+mcp-test@example.com" },
    { "action": "click", "selector": "button[type=submit]" },
    { "action": "assertText", "selector": ".result", "value": "Thanks" }
  ]
}
```

The result contains the run ID and status, case counts, healed steps and, per case, engine, device, location, status, exit IP and location match, failed steps, up to 20 console errors and failed requests, and the final URL. Up to four screenshots are returned as images, failed cases first, masked as usual and downscaled to at most 800 px wide. Artifacts are deleted once the result has been returned.

A case whose assertion fails is not a tool error: the call succeeds and the summary reports the case as `failed`. Tool errors carry the app's error codes, for example `INVALID_INPUT` for an origin that is not allowlisted or `SESSION_LIMIT` when the daily budget is used up.

### `run_manifest`

| Input | Notes |
| --- | --- |
| `path` | Manifest path relative to `QA_MCP_WORKSPACE` (up to 10 MB) |
| `environment` | Environment name from the manifest |
| `healing` | Overrides every scenario's mode |
| `baselines` | `.qavb` pack inside the workspace (up to 50 MB) |

Every scenario's approved origins, and the chosen environment's base URL, must be on the allowlist. The manifest's matrix counts against the per-call case limit, and cases × (retries + 1) attempts count against the daily budget.

## Policy settings

| Variable | Required | Default | Effect |
| --- | --- | --- | --- |
| `QA_MCP_ALLOWED_ORIGINS` | **yes** | none | Comma-separated origins, such as `https://staging.example.com,http://localhost:3000`. HTTPS, or HTTP only for `localhost`, `127.x.x.x` and `[::1]`. No paths, wildcards or credentials; at most 30 entries |
| `QA_MCP_WORKSPACE` | for `run_manifest` | none | Directory that manifests and baselines must resolve inside (symlinks and `../` cannot escape it). Also stores the budget state in `.qa-mcp/budget.json` |
| `QA_MCP_MAX_CASES` | no | 12 | Cases per tool call (1–100) |
| `QA_MCP_CONCURRENCY` | no | 2 | Concurrent browsers (1–4) |
| `QA_MCP_DAILY_BUDGET` | no | 200 | Case attempts per UTC day (1–10000); kept in memory when no workspace is set |

Invalid values stop the server with exit code 2 and a message naming the variable. Runs and exit-IP checks execute one at a time.

Proxy credentials use the same variables as the CLI runner (`QA_PROVIDER*`, `DATAIMPULSE_PROXY_*`, `QA_PROXY_*`); see [CI runner](/docs/ci-runner#proxy-credentials). Without them, `run_check` connects directly and location targets and `check_exit_ip` are unavailable. Site access tokens are not available to the server.

## Security model

The trust boundary is the MCP client: everything the assistant sends is treated as untrusted input, and the human operator controls the server's environment.

- The allowlist is checked before any engine check, budget reservation or browser launch, and the navigation guard blocks other origins and redirects during the run.
- `fill` and `select` values and scenario, dataset and environment variables are redacted from free-text result fields. Screenshots mask form fields.
- Only `run_manifest` reads files, and only inside `QA_MCP_WORKSPACE`. File contents are parsed, never returned.
- One audit line per call on stderr records the tool, origins, case count, outcome and duration, never input values.

**Submit buttons.** `run_check` and `run_manifest` allow clicks on submit buttons, which create real records, send emails or start workflows on the site under test. Therefore:

- Allowlist staging or test environments only, never production.
- Instruct the assistant to use synthetic data: `example.com` or `example.test` addresses and obviously fake names and phone numbers.
- Tag test submissions, for example with a `qa+mcp-…@` address, and treat them as test leads in your form backend.

The server does not control the desktop app or its sessions, offers no remote (HTTP or SSE) transport, and does no anti-bot evasion.

## Docker

The [runner image](/docs/ci-runner#docker-image) contains the server. Override the entrypoint and keep stdin open with `-i`:

```bash
docker run -i --rm --init --ipc=host \
  -e QA_MCP_ALLOWED_ORIGINS=https://staging.example.com \
  -v "$PWD/qa:/work" -e QA_MCP_WORKSPACE=/work \
  --entrypoint node ghcr.io/ubaidbinwaris/proxy-qa-runner:1.5.0 \
  /opt/proxy-qa-runner/out/main/qa-mcp.js
```

Do not pass `-t`: a TTY changes line endings and breaks the protocol stream. Add `--network host` (Linux) when the site under test runs on the host's `localhost`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| The client shows the server as failed and stderr says `configuration error` | Set `QA_MCP_ALLOWED_ORIGINS`, or fix the variable named in the message |
| `BROWSER_MISSING` | Run `npm run browsers:install`, or set `PLAYWRIGHT_BROWSERS_PATH` to installed browsers |
| `Origin not allowlisted` for `http://localhost:3000` vs `http://127.0.0.1:3000` | They are different origins; allowlist the one you open |
| Location targets refused | Configure proxy credentials and do not set `direct` |
| `SESSION_LIMIT` | The daily budget is used up. It resets at 00:00 UTC, or raise `QA_MCP_DAILY_BUDGET` |
| Garbled protocol or invalid JSON in the client | Start the server with `node …/qa-mcp.js`, not `npm run`, and without `docker -t` |

## Common questions

### Can the assistant open any website?

No. The server does not start without `QA_MCP_ALLOWED_ORIGINS`, the allowlist is checked before any browser launch, and the navigation guard blocks other origins and redirects during the run. The page's own scripts, images and API calls can still reach other origins: it limits navigation, it is not a network firewall.

### Does the MCP server need the desktop app?

No. It ships with the source code and the runner Docker image, runs under Node.js 22.13 or later, and does not control the desktop app or its sessions.
