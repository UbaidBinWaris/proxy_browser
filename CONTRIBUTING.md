# Contributing to Proxy QA Browser

Thanks for helping. This project is a desktop app for **authorized QA of web
forms you own or are contracted to test**, through isolated browser profiles,
device presets and verified proxy exit locations. Please read the scope section
before proposing a feature.

## Project scope

In scope:

- Launching, profiling and verifying browsers for QA (engines, devices, locations).
- Proxy provider adapters with honest, verifiable exit-location checks.
- QA automation: scenarios, matrices, assertions, visual and accessibility checks, reports, CI.
- Privacy of the tester's own data: credential vault, log redaction, evidence retention.

Out of scope — pull requests adding these will be closed:

- Defeating bot detection, CAPTCHA, rate limits or fraud controls (fingerprint
  spoofing or randomization aimed at anti-bot systems, CAPTCHA solving, "human-like" input to avoid detection).
- Bulk or unattended submissions to sites the operator does not control.
- Generating synthetic identities or consumer data intended to look real to a third party.

If your own site's bot protection blocks your QA runs, allowlist your test
traffic on that site (a test header/token, test keys from your CAPTCHA vendor,
or an allowlisted environment) instead of evading it.

## Development setup

Prerequisites, platform notes and the full architecture are in
[README.md — Part 2](README.md#part-2--for-developers) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```bash
npm ci
npm run browsers:install   # Playwright Chromium/Firefox/WebKit for local runs
npm run dev
```

**On a Mac** the same commands work (macOS 12+, Node ≥ 22.13, Xcode Command
Line Tools via `xcode-select --install`). `npm run build:mac:dir` packages an
ad-hoc signed `.app` for your Mac without any Apple account, and
`node scripts/macos-smoke.mjs` checks it; leave `CSC_LINK`, `CSC_KEY_PASSWORD`
and `APPLE_*` unset unless you mean to sign — a partial set fails the build
(see [docs/DISTRIBUTION.md → macOS](docs/DISTRIBUTION.md#macos)). The first
start may ask for access to the *Proxy-QA-Browser Safe Storage* Keychain item.
macOS code paths must stay testable on Linux: take `platform` as a parameter
(as `src/main/config/paths.ts` and `src/main/browser/engine-detect.ts` do) and
cover them in unit tests with `'darwin'` injected; CI runs the suite and the
packaged-app smoke test on `macos-latest` too.

No proxy account is needed for most work: direct (unproxied) launches and the
whole unit suite run without credentials. Never put real credentials in tests,
fixtures, screenshots or issue reports.

## Before opening a pull request

```bash
npm run verify   # typecheck + lint + tests + build
```

- Add or update tests for behavior you change. Pure logic belongs in testable
  modules (`src/main/**` helpers, `src/renderer/src/lib`) with injected
  filesystem, process and time.
- Keep changes focused: one feature or fix per pull request.
- Update the README or `docs/` when you change user-visible behavior.

## Code conventions

- TypeScript `strict`; no `any`; `import type` for types.
- Validate all external data with Zod. Shared types and schemas live only in
  `src/shared/`; the renderer never imports `src/main`.
- Errors cross IPC as `AppError { code, message, detail? }` with actionable
  messages and no stack traces or secrets.
- Register every credential with `logger.registerSecret()` as soon as it is
  known. Never log a `ProxyConnection`, a username with its password, or a
  `Proxy-Authorization` header.
- UI labels name exactly what runs (WebKit is "WebKit / Safari-compatible QA", never Safari).

## Adding a proxy provider

Provider-specific username and parameter syntax lives in one dialect file under
`src/main/proxy/providers/` (a `ProviderDialect`; the shared `GatewayProvider`
does everything else). Cite the provider's official documentation in the
file header, add a golden-table test of `compose()` taken from the documented
examples, add the id to `PROVIDER_IDS` and register the dialect in
`registry.ts` so the dialect contract suite covers it, and never hard-code
credentials or account identifiers. See
[docs/ARCHITECTURE.md → Proxy providers](docs/ARCHITECTURE.md#proxy-providers).

## Reporting security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
