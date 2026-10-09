# Architecture

How Proxy QA Browser is put together: an Electron main process that owns all state and secrets, a React renderer behind a typed IPC bridge, and two headless entry points for CI and AI assistants.

This page is a map. The full module reference, data flows and design notes are in [docs/ARCHITECTURE.md](https://github.com/UbaidBinWaris/proxy_browser/blob/main/docs/ARCHITECTURE.md).

## Process model

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Main process | Electron 44, Node's built-in `node:sqlite`, `playwright-core` 1.63 | All state and all secrets: the database, the credential vault, proxy providers, browser installers, Playwright, QA automation |
| Preload | `contextBridge` | Exposes exactly one object, `window.api`, with a fixed, typed set of functions |
| Renderer | React 19, Zustand, Tailwind CSS | The UI. It never imports main-process code and never sees a password |
| Headless entries | Plain Node | `out/main/qa-cli.js` (the [CI runner](/docs/ci-runner)) and `out/main/qa-mcp.js` (the [MCP server](/docs/mcp-server)), sharing the QA runtime without Electron |

Every IPC call is validated with Zod in the main process and answers `{ ok, data }` or `{ ok: false, error }`; it never throws across the boundary. Errors carry an `AppError { code, message, detail? }` with an actionable message and no secrets. Push events (session, run, log, network, task and security updates) stream progress to the renderer.

The Manage keys window is the same renderer at `#/keys`, in its own hardened, short-lived window.

## Contracts

Module boundaries are declared in three files; nothing else is shared:

| File | Purpose |
| --- | --- |
| [`src/shared/types.ts`](https://github.com/UbaidBinWaris/proxy_browser/blob/main/src/shared/types.ts) | Domain types and Zod schemas, settings and error codes, used by main and renderer |
| [`src/shared/ipc.ts`](https://github.com/UbaidBinWaris/proxy_browser/blob/main/src/shared/ipc.ts) | IPC channels, push events and the exact `window.api` shape |
| [`src/main/contracts.ts`](https://github.com/UbaidBinWaris/proxy_browser/blob/main/src/main/contracts.ts) | Main-process module interfaces and `AppException` |

QA automation schemas live in `src/shared/qa.ts` (scenarios, steps, matrices, policy) and `src/shared/qa-checks.ts` (check steps and evidence).

## Source layout

```text
src/
├── shared/      types + Zod schemas shared by main and renderer
├── preload/     contextBridge: exposes window.api
├── main/
│   ├── index.ts       entry: picks the browsers directory before playwright-core loads
│   ├── main.ts        composition root: bootstrap, windows, CSP, shutdown
│   ├── config/        paths and development .env loading
│   ├── security/      vault, AES-GCM crypto, key wrapping, install.json
│   ├── database/      node:sqlite, migrations, one repository per table
│   ├── logging/       logger and secret redaction
│   ├── proxy/         provider dialects, proxy manager, IP checker, WebKit relay
│   ├── locations/     GeoNames loader and location search
│   ├── launcher/      Quick Launch from the Launch page
│   ├── browser/       browser manager, provisioning, detection, device presets, installers
│   ├── tasks/         background install queue and headless verification
│   ├── sessions/      open-session record and crash clean-up
│   ├── site-access/   site access tokens
│   ├── desktop/       computer copy, shortcuts, updates, restart
│   ├── qa/            QA automation: executor, recorder, healing, checks, reports, CLI
│   ├── mcp/           MCP server: policy and one file per tool
│   └── ipc/           handlers per domain and the validation wrapper
└── renderer/src/
    ├── pages/         Launch, QA automation, Sessions, History, Profiles, Settings, Setup, Keys window
    ├── components/    feature components and UI primitives
    ├── lib/           pure, unit-tested UI logic
    └── stores/        Zustand stores
```

## Bootstrap

`playwright-core` reads `PLAYWRIGHT_BROWSERS_PATH` once, when it is first loaded. So `src/main/index.ts` first resolves the browsers directory (environment variable, then the bundled engines of the AppImage, then the provisioned `<userData>/data/browsers`, then Playwright's development cache) and only then imports `main.ts`.

`main.ts` then registers the screenshot scheme and the single-instance lock, opens the database (running migrations) and the logger, constructs the modules, cleans up browsers a crashed run left open, and after Electron's `ready` event opens the credential vault (the OS keychain is only usable from then on). No proxy test runs at start-up. Any failure shows a native error box.

## A launch, step by step

Launches are non-blocking: the IPC call returns as soon as the run and session records exist, and progress arrives as events.

1. The renderer calls `window.api.browser.launch(profileId)` (or a Quick Launch from the Launch page).
2. The main process validates the profile, resolves the engine and inserts a running `TestRun` and a live session.
3. **Verify:** the proxy manager resolves the provider and product, looks up the exit IP through the same login the browser will use, compares it with the target, and re-rolls sticky sessions according to the location policy.
4. **Launch:** Playwright starts the engine (installed browsers through the Chromium `BrowserType` with their own executable; WebKit with a proxy through the local relay) and one isolated `BrowserContext` with the device preset, locale, timezone and proxy, within a 45-second deadline.
5. **Navigate:** the start URL opens with the navigation timeout; status, final URL and network entries are recorded.
6. Closing the window finalizes the run as success, failed or aborted.

## Proxy providers

Provider support is split into three parts under `src/main/proxy/providers/`:

- A **dialect** per provider: pure, stateless code that composes the gateway, username, password and password-free targeting string, creates and rotates session IDs, and declares capabilities (products, target modes, session rules, default gateway, extra credential fields, billing note, encodings). A dialect never logs, stores credentials or does I/O.
- **`GatewayProvider`** implements the provider interface for any dialect: credentials per product, connection tests, session templates and secret registration.
- **`ProviderRegistry`** maps provider IDs to providers. An unknown ID fails with `INVALID_INPUT`; there is never a silent fallback.

`capabilities.verification: 'community'` marks a dialect written from public docs and not tested with a live account. See [Contributing](/docs/contributing#adding-a-proxy-provider) for how to add one.

## Data

SQLite via `node:sqlite` (WAL, foreign keys) in `<userData>/data/proxy-qa.sqlite`. Tables include `profiles`, `proxy_sessions`, `test_runs`, `network_entries`, `app_settings`, `logs` and the `qa_*` automation tables. Migrations live in `src/main/database/schema.ts`; each runs once in its own transaction. Never edit a published migration; add a new one. No column ever holds a login or password.

The vault, its key and site access tokens are separate encrypted files. See [Security and privacy](/docs/security-and-privacy).

## QA automation

The `src/main/qa/` modules validate scenarios, resolve variables and environments, plan matrices and suites, execute cases with bounded concurrency, and write reports. Key pieces:

- `qa/navigation.ts`: the origin guard. Every document request is fetched with redirects disabled and each hop is decided by a pure function, so navigation never leaves the approved origins.
- `qa/healing.ts`: pure ordering and validation of [self-healing](/docs/self-healing) fallbacks, used only for action steps.
- `qa/checks/`: [checks](/docs/checks) with pure, unit-tested decisions (contrast, wording diff, visibility, budgets, script presets) and read-only page probes.
- `src/main/site-access/`: exact-origin [site access token](/docs/site-access-tokens) routing, used by manual sessions and desktop automation but never by the CLI.

## Security boundaries

- Anything that can contain a credential stays in the main process. The renderer receives only host, port, a masked username and the vault's health.
- Every credential is registered with the log redactor as soon as it is known.
- Windows use context isolation, the sandbox and a strict Content Security Policy; navigation away from the app and `window.open` are blocked.
- WebKit gets proxy credentials only through a per-session loopback relay.
