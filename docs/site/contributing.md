# Contributing

How to set up a development environment, the project's conventions and scope, and what a pull request needs.

The canonical guide is [CONTRIBUTING.md](https://github.com/UbaidBinWaris/proxy_browser/blob/main/CONTRIBUTING.md). Participation is governed by the [Code of Conduct](https://github.com/UbaidBinWaris/proxy_browser/blob/main/CODE_OF_CONDUCT.md).

## Project scope

Proxy QA Browser is a desktop app for **authorized QA of web forms you own or are contracted to test**. Please check a feature against this scope before proposing it.

In scope:

- Launching, profiling and verifying browsers for QA (engines, devices, locations).
- Proxy provider adapters with honest, verifiable exit-location checks.
- QA automation: scenarios, matrices, assertions, visual and accessibility checks, reports, CI.
- Privacy of the tester's own data: credential vault, log redaction, evidence retention.

Out of scope; pull requests adding these will be closed:

- Defeating bot detection, CAPTCHA, rate limits or fraud controls: fingerprint spoofing or randomization aimed at anti-bot systems, CAPTCHA solving, "human-like" input to avoid detection.
- Bulk or unattended submissions to sites the operator does not control.
- Generating synthetic identities or consumer data intended to look real to a third party.

If your own site's bot protection blocks your QA runs, allowlist your test traffic on that site (see [Site access tokens](/docs/site-access-tokens)) instead of evading it.

## Development setup

Prerequisites:

| What | Version | Notes |
| --- | --- | --- |
| Node.js | 22.13 or newer | Tests and tooling use `node:sqlite`. CI uses Node 24 |
| npm | 10 or newer | Use `npm ci` |
| Docker (optional) | Any recent | Cross-building the Windows EXE from Linux |
| A Mac (optional) | macOS 12+, Xcode Command Line Tools | macOS builds and the macOS smoke test |

No native Node modules are compiled.

```bash
npm ci
npm run browsers:install          # Playwright Chromium, Firefox and WebKit for local runs
cp .env.example .env              # optional, development only
env -u ELECTRON_RUN_AS_NODE npm run dev
```

- **No proxy account is needed** for most work. Direct launches and the whole unit suite run without credentials.
- `.env` is read **in development only**; packaged builds never read it. It can hold one development login (`QA_PROVIDER*` or `DATAIMPULSE_PROXY_*`). Anything saved in the vault takes precedence. Never commit `.env`.
- Development and packaged builds share `~/.config/proxy-qa-browser`. Use `--user-data-dir=<dir>` for a separate profile.
- Shells inside VS Code or Cursor export `ELECTRON_RUN_AS_NODE`; prefix Electron commands with `env -u ELECTRON_RUN_AS_NODE`.
- On Arch Linux, Playwright's WebKit needs Ubuntu libraries in development. See [Arch Linux notes](https://github.com/UbaidBinWaris/proxy_browser/blob/main/README.md#arch-linux-notes) in the README.
- **On a Mac** the same commands work. `npm run build:mac:dir` packages an ad-hoc signed `.app` for your Mac without an Apple account, and `node scripts/macos-smoke.mjs` checks it. Leave `CSC_LINK`, `CSC_KEY_PASSWORD` and `APPLE_*` unset unless you mean to sign; a partial set fails the build.

## Useful scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Main, preload and renderer with hot reload |
| `npm test` | The Vitest suite |
| `npm run typecheck` | TypeScript for the main and renderer projects |
| `npm run lint` | ESLint |
| `npm run verify` | Typecheck, lint, tests and build |
| `npm run build` | Build `out/` and check that the headless entries load no Electron |
| `npm run qa -- --config …` | Run the [CI runner](/docs/ci-runner) from the build |

Packaging scripts are in [Building and releasing](/docs/building-and-releasing).

## Before opening a pull request

```bash
npm run verify   # typecheck + lint + tests + build
```

- Add or update tests for behaviour you change. Pure logic belongs in testable modules (`src/main/**` helpers, `src/renderer/src/lib`) with injected filesystem, process and time.
- Keep changes focused: one feature or fix per pull request.
- Update the README or `docs/` (including these pages in `docs/site/`) when you change user-visible behaviour.
- Never put real credentials, account identifiers, cookies or personal data in tests, fixtures, screenshots or issue reports. Use placeholders such as `brd-customer-EXAMPLE`.

## Code conventions

- TypeScript `strict` (plus `noUncheckedIndexedAccess` and `noImplicitOverride`); no `any`; `import type` for types.
- Validate all external data with **Zod**: IPC arguments, settings, vault files, `install.json`, IP-service responses. Shared types and schemas live only in `src/shared/`; the renderer never imports `src/main`.
- Errors cross IPC as `AppError { code, message, detail? }` with actionable messages and no stack traces or secrets.
- **No secrets in logs.** Register every credential with `logger.registerSecret()` as soon as it is known. Never log a `ProxyConnection`, a username with its password, or a `Proxy-Authorization` header.
- UI labels name exactly what runs: WebKit is "WebKit / Safari-compatible QA", never Safari; installed browsers are named as themselves.
- Never edit a published database migration; add a new one.
- macOS code paths must stay testable on Linux: take `platform` as a parameter and cover the `'darwin'` case in unit tests.

## Adding a proxy provider

Provider-specific username and parameter syntax lives in one dialect file under [`src/main/proxy/providers/`](https://github.com/UbaidBinWaris/proxy_browser/tree/main/src/main/proxy/providers). The shared `GatewayProvider` does everything else.

1. Write the dialect from the provider's **official** parameter documentation and cite the pages in the file header, including anything left out.
2. Add a golden-table test of `compose()` (request to server, username and password) taken from the documented examples.
3. Add the ID to `PROVIDER_IDS` in `src/shared/types.ts` and register the dialect in `BUILT_IN_DIALECTS` in `registry.ts`. The dialect contract suite then covers it automatically.
4. Mark it `verification: 'community'` unless it has been tested with a live account.
5. Never hard-code credentials or account identifiers.

No launcher, browser-manager or QA-runtime change is needed. See [Architecture](/docs/architecture#proxy-providers).

## Reporting security issues

Do not open a public issue. Report vulnerabilities privately through **GitHub → Security → Report a vulnerability** on the repository; details are on the [Security](/security) page and in [SECURITY.md](https://github.com/UbaidBinWaris/proxy_browser/blob/main/SECURITY.md). Requests to bypass bot detection, CAPTCHA or fraud controls are not vulnerabilities and are out of scope.

## License

The project is licensed under the [Apache License 2.0](https://github.com/UbaidBinWaris/proxy_browser/blob/main/LICENSE). Unless you state otherwise, contributions you submit are licensed under the same terms (section 5 of the license).
