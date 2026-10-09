# MCP server for AI assistants

`qa-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server.
It lets an AI coding assistant such as Claude Code or Cursor run geo- and
device-aware QA checks with the same headless runtime as the
[CI runner](CI-RUNNER.md). You can ask the assistant, for example, "open
staging.example.com on an iPhone 15 in WebKit from Austin, TX, submit the form
with synthetic data and tell me what broke." The assistant gets a structured
result and up to four screenshots back.

- **stdio only.** The server opens no network listener. Protocol messages use
  stdout, and every log and audit line goes to stderr.
- **Allowlisted origins only.** The server does not start without
  `QA_MCP_ALLOWED_ORIGINS`. The assistant cannot open any other origin.
- **No credentials for the assistant.** Proxy credentials come from the
  server's environment. They are removed from it before a browser starts and
  are redacted from every result.
- **Bounded.** Each call has a case limit, the number of concurrent browsers is
  capped, and each UTC day has a budget of case attempts.

Use it only on sites you own or are contracted to test. See the scope in
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Contents

- [Build](#build)
- [Client setup](#client-setup)
- [Tools](#tools)
- [Policy settings](#policy-settings)
- [Proxy settings](#proxy-settings)
- [Security model](#security-model)
- [Docker](#docker)
- [Troubleshooting](#troubleshooting)

## Build

```bash
npm ci
npm run build                 # emits out/main/qa-mcp.js next to out/main/qa-cli.js
npm run browsers:install      # Chromium, Firefox and WebKit, if not installed yet
```

The entry needs Node.js 22.13 or later and the production dependencies in
`node_modules`. It runs under plain Node, not Electron. `npm run build` checks
that neither `qa-cli.js` nor `qa-mcp.js` loads Electron
(`scripts/check-headless-entries.mjs`).

Check that it refuses to start without an allowlist:

```bash
node out/main/qa-mcp.js
# qa-mcp configuration error: QA_MCP_ALLOWED_ORIGINS is required: …   (exit code 2)
```

Start the server with `node` directly, never with `npm run`. npm writes its own
banner to stdout, which corrupts the protocol stream.

## Client setup

Every client starts the server as a child process and talks to it over stdio.
Use absolute paths.

### Claude Code

Add the server to the project's `.mcp.json`, or to your user configuration with
`claude mcp add`:

```json
{
  "mcpServers": {
    "proxy-qa": {
      "command": "node",
      "args": ["/path/to/proxy_browser/out/main/qa-mcp.js"],
      "env": {
        "QA_MCP_ALLOWED_ORIGINS": "https://staging.example.com",
        "QA_MCP_WORKSPACE": "/path/to/your-app/qa",
        "QA_PROVIDER": "dataimpulse",
        "QA_PROVIDER_USERNAME": "…",
        "QA_PROVIDER_PASSWORD": "…"
      }
    }
  }
}
```

The same with the CLI:

```bash
claude mcp add proxy-qa \
  -e QA_MCP_ALLOWED_ORIGINS=https://staging.example.com \
  -- node /path/to/proxy_browser/out/main/qa-mcp.js
```

Do not commit a `.mcp.json` that contains credentials. Keep them in your user
configuration, or reference variables your shell already exports if your client
supports that.

### Cursor

Add the same block to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json`
(one project):

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

Leave the proxy variables out for direct (unproxied) checks, for example
against a local development server.

### Other clients

Any MCP client that supports the stdio transport works. The command is
`node /path/to/out/main/qa-mcp.js` and the configuration comes from environment
variables only. The server takes no arguments.

## Tools

Results are JSON text content. `run_check` and `run_manifest` also return
images. Errors are MCP tool errors (`isError: true`) whose text is
`{"error":{"code":"<code>","message":"…"}}`. The codes are the app's
`AppError` codes:

| Code | Typical cause |
| --- | --- |
| `INVALID_INPUT` | Origin not allowlisted, invalid step or argument, too many cases, device incompatible with the engine, path outside the workspace |
| `SESSION_LIMIT` | Daily budget exhausted or too small for this call |
| `BROWSER_MISSING` | An engine is not installed |
| `PROXY_NOT_CONFIGURED` | Proxy or location features requested without credentials |
| `PROXY_DEAD`, `PROXY_AUTH_FAILED`, `PROXY_TIMEOUT`, `IP_VERIFY_FAILED` | Exit IP check failed |
| `NOT_FOUND` | Unknown tool, run id or workspace file |
| `SESSION_CLOSED` | The request was cancelled, or the server is shutting down |
| `INTERNAL` | Unexpected failure (message redacted) |

A case whose assertion fails is not a tool error. The call succeeds and the
summary reports the case as `failed`.

### `list_capabilities`

No input. Returns:

- the installed engines with versions, and the unavailable ones with a note;
- the proxy providers with their products, target modes and the products the
  environment supplied credentials for;
- whether a custom gateway (`QA_PROXY_SERVER`) is configured;
- the limits: allowed origins, cases per call, concurrency, daily budget,
  attempts remaining today, and whether a workspace is set.

The assistant should call this tool first.

### `search_devices`

| Input | Type | Notes |
| --- | --- | --- |
| `query` | string, ≤ 80 | Words to match in the id, name, brand or OS (`"iphone 15 pro"`, `"galaxy"`, `"windows"`) |
| `limit` | 1–20, default 10 | |
| `engine` | engine id | Only presets this engine can emulate |
| `deviceType` | `desktop`, `mobile`, `tablet` | |

Returns preset ids (for `run_check` `devices`) with name, device type, viewport
and the engines that can emulate each preset. Popular current devices come
first. Firefox cannot emulate phones or tablets.

### `search_locations`

| Input | Type | Notes |
| --- | --- | --- |
| `query` | string, 1–80 | `"austin tx"`, `"new jersey"`, `"78701"` |
| `limit` | 1–20, default 10 | |
| `mode` | `country`, `state`, `city`, `zip` | Default: ZIP codes for digits, otherwise states, then cities |
| `stateCode` | two letters | Only cities and ZIP codes in this state |

The search uses the bundled GeoNames US dataset (CC BY 4.0). Each entry
includes a `target` object that can be passed unchanged to `run_check` `targets`
or `check_exit_ip` `target`.

### `check_exit_ip`

| Input | Type | Notes |
| --- | --- | --- |
| `provider` | provider id | Default: the configured provider |
| `product` | product key | Default: the configured product |
| `target` | `target` object | Requested location |

Opens a sticky proxy session and verifies the exit IP. For a target, it re-rolls
the session up to three times until the location matches. Returns the exit IP,
its country, region, city, postal code, ISP and ASN, the match verdict
(`match`, `partial`, `mismatch`), the attempts used and any warning. Each call
counts one case attempt against the daily budget. Only the provider and product
that have credentials on this server can be checked.

### `run_check`

| Input | Type | Notes |
| --- | --- | --- |
| `url` | http(s) URL | Start URL. Its origin must be allowlisted. URLs with credentials are refused |
| `engines` | 1–10 engine ids | e.g. `["chromium", "webkit"]` |
| `devices` | 1–20 preset ids | From `search_devices` |
| `targets` | ≤ 20 `target` objects | Optional. Needs proxy credentials |
| `steps` | 1–100 steps | Optional. Default: `[{ "action": "assertVisible", "selector": "body" }]` |
| `healing` | `off`, `warn`, `fail` | Selector self-healing, default `warn` |
| `direct` | boolean | Connect without the proxy even when credentials are configured, e.g. for a localhost site |
| `timeoutMs` | 1000–60000 | Per-step timeout, default 15000 |

The tool runs every engine × device × target combination as one case. Steps use
the scenario step schema of the desktop app and the manifests (`src/shared/qa.ts`):
`goto`, `fill`, `click`, `select`, `check`, `uncheck`, `assertVisible`,
`assertText`, `assertUrl`, `assertStatus` and `assertScreenshot`. Action steps
may carry `fallbacks` for self-healing. No other actions exist. In particular,
there is no arbitrary JavaScript, no file upload and no download. A `goto` step
needs an absolute URL on an allowlisted origin.

Example arguments:

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

The result contains:

- `runId`, the run `status` (`passed`, `failed` or `cancelled`), the case counts
  and the number of healed steps.
- For each case:
  - engine, device and location;
  - status, attempt and duration;
  - the exit IP and the location match;
  - the failed steps with their errors;
  - the healed steps with the original and the suggested selector;
  - up to 20 console errors and failed requests;
  - the final URL and any notes.
- Up to four screenshots as MCP image content, one per case, failed cases
  first. Each shows the failing step, or the last step of a passed case.
  Screenshots are masked as usual: every input, textarea, editable element and
  `[data-qa-sensitive]` is blacked out. They are downscaled to at most 800 px
  wide. `screenshots` in the JSON names the case and step of each image.

Screenshots and other artifacts are deleted once the result has been returned.

### `run_manifest`

| Input | Type | Notes |
| --- | --- | --- |
| `path` | string | Scenario or suite manifest exported from the desktop app, relative to `QA_MCP_WORKSPACE` |
| `environment` | string | Environment name from the manifest |
| `healing` | `off`, `warn`, `fail` | Overrides every scenario's mode |
| `baselines` | string | Approved screenshot pack (`.qavb`) inside the workspace |

Runs the manifest like `npm run qa -- --config …` does and returns the same
summary and screenshots as `run_check`. Every scenario's approved origins, and
the chosen environment's base URL, must be on the allowlist. The tool plans the
manifest's own matrix (engines, devices, targets, datasets and retries): the
cases count against the per-call limit, and the cases × (retries + 1) attempts
count against the daily budget. Manifests are limited to 10 MB and baseline
packs to 50 MB.

### `get_results`

| Input | Type |
| --- | --- |
| `runId` | string |

Returns the stored summary of an earlier `run_check` or `run_manifest` call in
the same server process, without screenshots. The server keeps the latest 50
runs in memory.

## Policy settings

| Variable | Required | Default | Effect |
| --- | --- | --- | --- |
| `QA_MCP_ALLOWED_ORIGINS` | **yes** | – | Comma-separated origins, such as `https://staging.example.com,http://localhost:3000`. Use https, or http only for `localhost`, `127.x.x.x` and `[::1]`. An entry is one origin: no path, query, fragment, credentials or wildcard. At most 30 entries. The server refuses to start without it. Every `run_check` URL and `goto` step, and every manifest scenario's approved origins, must be on this list. |
| `QA_MCP_WORKSPACE` | for `run_manifest` | – | Directory that manifests and baselines must resolve inside. The server resolves real paths first, so neither `../` nor a symlink can lead out of it. It also stores the budget state in `.qa-mcp/budget.json` (owner-only) under this directory. |
| `QA_MCP_MAX_CASES` | no | 12 | Maximum cases per tool call (1–100) |
| `QA_MCP_CONCURRENCY` | no | 2 | Concurrent browsers (1–4) |
| `QA_MCP_DAILY_BUDGET` | no | 200 | Case attempts per UTC day (1–10000). The count persists in the workspace state file, or in memory when no workspace is set (then it resets when the server restarts) |

Invalid values stop the server with exit code 2 and a message that names the
variable. Runs and exit IP checks execute one at a time: a `run_check`,
`run_manifest` or `check_exit_ip` call made while another one runs waits for it.

## Proxy settings

The server reads the same variables as the CLI runner. See
[CI runner → Environment variables](CI-RUNNER.md#environment-variables).

| Variables | Purpose |
| --- | --- |
| `QA_PROVIDER`, `QA_PROVIDER_PRODUCT`, `QA_PROVIDER_HOST`, `QA_PROVIDER_PORT`, `QA_PROVIDER_USERNAME`, `QA_PROVIDER_PASSWORD`, `QA_PROVIDER_EXTRA_<KEY>` | Provider gateway for checks and proxied manifest profiles. `QA_PROVIDER_PRODUCT` selects the product (default: the provider's first product) |
| `DATAIMPULSE_PROXY_HOST`, `_PORT`, `_USERNAME`, `_PASSWORD` | Alias for `QA_PROVIDER=dataimpulse` |
| `QA_PROXY_SERVER`, `QA_PROXY_USERNAME`, `QA_PROXY_PASSWORD` | One custom gateway that replaces profile routing for every case. Needed for manifests whose scenarios use custom gateways |

Without them, `run_check` connects directly. Location targets and
`check_exit_ip` are then unavailable. Site access tokens are a desktop-only
feature and the server cannot use them.

## Security model

The trust boundary is the MCP client. The server treats everything the
assistant sends as untrusted input. The human operator controls the server's
environment.

| Threat | Control |
| --- | --- |
| The assistant opens arbitrary sites | The origin allowlist is checked before an engine check, a budget reservation or a browser launch. During the run, the existing navigation guard blocks navigation to any other origin and HTTP document redirects. The scenario's approved origins are exactly the allowlist |
| The assistant reads proxy credentials | Credentials are never inputs. They are read once at start-up and removed from `process.env` before a browser launches. Every result and error passes through the log redactor (registered secrets, `user:pass@` URLs, `Authorization` and `Proxy-Authorization` headers) and the evidence redactor (sensitive query parameters, URL fragments) |
| Test data leaks into results | `fill` and `select` values, scenario variables, dataset values and environment variables of the call are redacted from every free-text field. Screenshots mask form fields |
| The assistant reads files | Only `run_manifest` reads files, and only manifests and baseline packs whose real path is inside `QA_MCP_WORKSPACE`. Contents are parsed, never returned |
| Runaway usage | Per-call case limit, browser concurrency cap and a daily budget of case attempts. Budget is reserved before a run starts |
| Arbitrary code | No JavaScript evaluation, uploads or downloads. Steps are the fixed scenario schema. Traces are never captured |
| Network exposure | stdio only. The server opens no port |
| Accountability | One audit line per call on stderr: tool, origins, case count, outcome and duration, never input values |

An audit line looks like this:

```json
{"audit":"qa-mcp","at":"2026-10-09T12:48:38.733Z","tool":"run_check","origins":["https://staging.example.com"],"cases":2,"outcome":"passed","ms":1593}
```

**Submit buttons.** `run_check` and `run_manifest` allow clicks on submit
buttons by default. Such a click creates real records, sends emails or starts
workflows on the site under test. This is acceptable because only the
operator's own allowlisted staging origins are reachable. Even so:

- Allowlist staging or test environments only, never production.
- Instruct the assistant to use synthetic data: `example.com`/`example.test`
  addresses and obviously fake names and phone numbers.
- Tag test submissions so they can be found and removed, for example with a
  `qa+mcp-…@` address or a marker in a free-text field. Treat them as **test
  leads** in your form backend, so they are never sold, billed, routed to sales
  or counted in metrics, as the
  [site access token guidance](../README.md#site-access-tokens-allowlisting-your-own-qa-traffic)
  describes for the desktop app.

**Out of scope:**

- The server does not control the desktop app or its open sessions. A bridge
  into the running app is not part of this server.
- It offers no remote (HTTP/SSE) transport.
- It does no anti-bot evasion.

## Docker

The [runner image](CI-RUNNER.md#runner-image) contains the server. Its
entrypoint is the CLI, so override it, and keep stdin open with `-i`:

```bash
docker run -i --rm --init --ipc=host \
  -e QA_MCP_ALLOWED_ORIGINS=https://staging.example.com \
  -e QA_PROVIDER -e QA_PROVIDER_USERNAME -e QA_PROVIDER_PASSWORD \
  -v "$PWD/qa:/work" -e QA_MCP_WORKSPACE=/work \
  --entrypoint node ghcr.io/ubaidbinwaris/proxy-qa-runner:1.4.0 \
  /opt/proxy-qa-runner/out/main/qa-mcp.js
```

As a client configuration:

```json
{
  "mcpServers": {
    "proxy-qa": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--init", "--ipc=host",
               "-e", "QA_MCP_ALLOWED_ORIGINS=https://staging.example.com",
               "--entrypoint", "node", "ghcr.io/ubaidbinwaris/proxy-qa-runner:1.4.0",
               "/opt/proxy-qa-runner/out/main/qa-mcp.js"]
    }
  }
}
```

Do not pass `-t`. A TTY changes line endings and breaks the protocol stream.
Add `--network host` (Linux) when the site under test runs on the host's
`localhost`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| The client shows the server as failed, and stderr says `configuration error` | Set `QA_MCP_ALLOWED_ORIGINS`, or fix the variable named in the message |
| `BROWSER_MISSING` | `npm run browsers:install` (or `PLAYWRIGHT_BROWSERS_PATH` pointing at installed browsers) |
| `Origin not allowlisted` for `http://localhost:3000` vs `http://127.0.0.1:3000` | They are different origins. Allowlist the one you open |
| Location targets refused | Configure proxy credentials, and do not set `direct` |
| `SESSION_LIMIT` | The daily budget is used up. It resets at 00:00 UTC, or raise `QA_MCP_DAILY_BUDGET` |
| Garbled protocol, or the client reports invalid JSON | Start the server with `node …/qa-mcp.js`, not `npm run`, and without `docker -t` |
