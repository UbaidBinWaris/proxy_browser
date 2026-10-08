# Desktop QA automation

This edition stays local: no sign-in, shared server, cloud account, or remote worker is required. Workspaces organize projects on one installation. Local audit records describe changes made through the app; they are not authenticated-user records or tamper-proof compliance evidence.

## Start a regression suite

1. Create a saved browser profile in **Profiles**. Select direct routing or configure the existing DataImpulse vault.
2. Open **QA automation**, choose or create a workspace, and select **New scenario**.
3. Choose a base profile, enter the starting URL, and add actions and assertions. The starting URL's origin is approved by default; add other approved origins explicitly when using navigation steps.
4. Select **Run matrix**, choose installed browsers and compatible devices, and optionally add DataImpulse locations. The runner refuses unsupported browser/device combinations and direct-connection location tests before creating a batch.
5. Inspect **Results** for each combination, failure details, console errors, failed HTTP requests, step screenshots, and retry counts. Export JSON, JUnit XML, or standalone HTML reports.

Supported steps: navigate, fill, click, select, check, uncheck, compare screenshot, expect visible, expect text, expect URL contains, and expect navigation HTTP status. Text, visibility, and URL assertions wait within the configured step timeout. Each case and retry uses a fresh browser context and a temporary profile, without modifying the saved base profile. The temporary profile is deleted when its attempt finishes.

Automation runs headlessly. Manual sessions continue using the existing Launch and Sessions screens. There is one active automation batch per installation; cases within that batch run concurrently up to the local policy limit. A failed case can be retried at most twice. Retrying repeats all actions, including submissions: use dedicated test environments and synthetic data. JSON retains every attempt's evidence; a passing case with retries is identified in the results screen.

### Record actions

In the scenario editor, enter a starting URL and choose **Record actions**. A separate visible browser opens with a temporary profile. Interact with your test form, then choose **Stop recording** in the app and **Use recorded steps**. Review the steps, add expected-result assertions, and save. The recorder captures text inputs, single-select choices, checkbox changes, and button/link clicks; repeated typing in the same field becomes one fill step. Password fields and elements marked `data-qa-sensitive` are excluded. Recording is a draft in memory until you save it.

The main page is supported. Frames, shadow DOM, pop-ups, file uploads, rich-text editors, and special keyboard gestures need manual or future actions. HTTP document redirects follow the same isolation rules as automation. Closing the recording browser stops capture. Starting a test or a scheduled run while recording is refused; changing editor/workspace or cancelling the editor stops recording. Use synthetic data: ordinary text inputs are recorded as entered.

### Variables and datasets

Expand **Variables and datasets** in the editor. Default variables are a JSON object:

```json
{ "email": "synthetic@example.test", "expected": "Submitted" }
```

Use `{{email}}` in a fill value and `{{expected}}` in an expected-text value. Variables can also appear in selectors and navigation URLs; resolved URLs are validated before any browser starts. Missing variables, invalid URLs, and unapproved navigation stop the entire run during preflight.

Dataset rows contain a stable `id`, a readable `name`, and `variables`:

```json
[
  { "id": "valid", "name": "Valid email", "variables": { "email": "valid@example.test" } },
  { "id": "empty", "name": "Empty email", "variables": { "email": "", "expected": "Email is required" } }
]
```

**Import dataset CSV** replaces the rows in this draft. Column headers become variable names; optional `_name` labels each row. Quoted commas, quotes and newlines are supported. Limits: 1 MB CSV, 100 rows, 50 variables, and 10,000 characters per value. These variables are plain local configuration, not a secret vault; they appear in configuration backups and CI exports.

The matrix runs all rows by default, or only the rows checked in **Datasets**. Each row receives a fresh browser context. Results and exported reports identify the scenario, dataset, and environment. Dataset values are not copied into result metadata, although page content may still show them outside screenshot masks.

### Suites and environments

Under **Suites & environments**, save named environments and group scenarios into a suite. An environment has a base HTTP/HTTPS origin and optional variables. Only the origin is used; URL paths, query parameters and fragments stay the same. Navigation steps on the scenario's original starting origin and its approved-origin entry are rewritten to the selected environment. Other approved origins remain explicit. Variable precedence: scenario defaults → environment variables → dataset values. `baseUrl` is reserved for the selected environment's origin.

Choose **Run suite**, select the environment and matrix, and start. Every scenario retains its own base profile; selected matrix engines/devices override those profiles. Suite runs include all datasets. Case limits, concurrency, retries, cancellation and the daily budget cover the whole suite. Cross-workspace scenarios and environments are refused. Remove a scenario from its suites before deleting it; delete dependent schedules before deleting suites/environments.

### Visual comparisons

Add a **Compare screenshot** step with a unique baseline name and allowed difference ratio (0–1; default 0.01 means 1%). Screenshots use the same masks as other evidence, disable animations, and wait for fonts within the step timeout. The first run fails with **No approved visual baseline**. In **Results**, expand the case, choose **View comparison**, review the current screenshot, then explicitly choose **Approve baseline**. Run again to compare.

Changed runs show the approved screenshot used during that run, current screenshot and highlighted pixel differences. Size changes fail the comparison. Approval updates the baseline for future runs and does not rewrite historical results. Baseline identity includes scenario, dataset ID, screenshot name, masks, operating system/architecture, browser/version, device/viewport, locale/timezone, location, and starting origin. Use stable dataset IDs. Browser upgrades or a different CI platform may require new baselines. Dynamic page content needs extra masks or stable test fixtures.

Approved baselines live separately from retained run evidence and configuration backups. **Export approved baselines for CI** writes a `.qavb` pack; keep it with the corresponding scenario or suite manifest. It contains masked PNGs and hashed identities, without local file paths. Export is limited to 35 MB decoded image data; each image is limited to 10 MB and 8 million pixels. Baselines are never approved automatically by the CLI.

### Origin isolation

Document navigation is restricted to the approved origins. **HTTP document redirects are blocked**, including redirects between approved origins: Playwright only routes the first request of an HTTP redirect chain. Use the final starting URL or explicit navigation steps. The form's ordinary scripts, images, and API resources can still request other origins; this is a navigation boundary, not a complete network-egress firewall. Arbitrary user-supplied JavaScript actions are not supported.

For DataImpulse location matrices, the runner verifies the exit IP before opening the browser and requires an exact target match. Provider availability, IP-check services, and location accuracy remain external dependencies. No proxy credentials are needed for direct local tests.

## Custom proxy providers

In **Data controls → Custom proxy gateways**, save another provider's HTTP/HTTPS gateway or an unauthenticated SOCKS5 gateway. Credentials are stored using Electron's OS-backed keychain encryption; unsupported Linux keychain backends are refused. HTTP gateways support username/password authentication. WebKit custom gateways require HTTP. Select the gateway when editing a scenario; it overrides the base profile's proxy and target.

Custom gateways expose connection health, verified exit IP, and verification latency. DataImpulse-specific location and sticky-session parameters are not applied to these gateways. Configure another provider's targeting syntax in its username if needed. The case-attempt budget limits executions, not provider bandwidth or currency spend.

## Scheduling and execution policy

**Schedules** run while the app is open. Choose a scenario and interval of 5 minutes to 7 days. Pause, resume, or delete a schedule from the same screen. Missed intervals are skipped rather than replayed. Each scheduled run uses the base profile with one worker and no retries; inspect its result under Results. Budget or validation failures appear as a last-attempt message.

**Data controls** configure:

- Evidence retention: 1–3,650 days; default 30 days.
- Maximum cases per matrix: 1–500; default 100.
- Concurrent automated browsers: 1–4; default 2.
- Daily case-attempt budget: 1–10,000; default 500, measured by UTC day and conservatively including all requested retries.
- Whether scenarios may capture raw traces; disabled by default.

Interrupted batches are marked on restart. They are not automatically resubmitted. Retention removes expired completed automation records and their evidence at startup and during hourly checks while the app is open; **Clean expired evidence** runs it manually. Active batches are preserved. Retention does not delete manual launch history, log files, exported reports, or configuration backups. Exported artifacts need their own lifecycle management.

## Privacy, backup, and diagnostics

Captured network and run URLs mask known sensitive query parameters and discard fragments. Migration 6 also redacts previously stored captured URLs. Existing saved profile URLs and exported scenario manifests remain executable configuration, so use synthetic data and keep secrets out of URLs and test steps.

Screenshots mask inputs, textareas, contenteditable elements, and `[data-qa-sensitive]` elements by default. Scenarios can add CSS selectors to mask other page content. These masks do not automatically identify personal information elsewhere on a page. Invalid selectors prevent screenshot capture. Screenshots and result files are local artifacts, not encrypted databases.

Playwright traces can contain raw DOM and network data. They require both policy permission and a scenario opt-in. Screenshot masks do not redact traces. The CLI disables traces by default.

**Encrypted configuration backup** includes saved profiles, workspaces, scenarios (with variables/datasets), suites, environments, and a copy of policy. It excludes proxy credentials, browser cookies, schedules, run history, and screenshots. AES-256-GCM authenticates each backup; scrypt derives its key from a passphrase of at least 12 characters. Restore validates the entire configuration and imports independent copies in a transaction. Existing data and current execution policy are retained. A restored scenario referring to a missing custom gateway must be edited to select a newly configured gateway.

**Export diagnostics** writes app/platform information, browser availability, recent batch statuses, and redacted log messages. Review the file before sharing it. No automatic upload occurs.

## CI command-line runner

Use **Export for CI** on a scenario, then run:

```bash
npm run build
npm run qa -- --config /path/to/scenario.json --output qa-results
```

The manifest contains `scenario`, `profile`, and optionally `matrix`. The optional matrix accepts `engines`, `devices`, `targets`, `concurrency`, and `retries`; the runner supplies its own scenario identifier. Suites use **Export suite for CI**, which includes their scenarios, profiles and workspace environments. To choose an exported environment or compare approved screenshots:

```bash
npm run qa -- --config suite.json --environment "Staging" --output qa-results
npm run qa -- --config scenario.json --baselines approved.qavb --output qa-results
```

Environment names must be unique in the exported manifest. The CLI uses the exported environment settings; it never resolves desktop IDs directly. One optional custom gateway from environment variables applies to the entire CLI run. Imported baselines are temporary copies, and missing/changed comparisons exit with a test failure.

Install the required browser engines before running. The CLI uses a temporary in-memory database and fresh contexts, never the desktop's credential vault. Its browser downloads are not automatic.

For a DataImpulse profile, provide `DATAIMPULSE_PROXY_HOST`, `DATAIMPULSE_PROXY_PORT`, `DATAIMPULSE_PROXY_USERNAME`, and `DATAIMPULSE_PROXY_PASSWORD` through CI secrets. For a custom gateway, provide `QA_PROXY_SERVER` and, for HTTP authentication, `QA_PROXY_USERNAME` and `QA_PROXY_PASSWORD`. Custom gateway credentials override profile routing. No `.env` file is loaded, and credential environment variables are removed before launching browsers.

Outputs: `results.json`, `results.xml` (JUnit), `results.html`, and an `artifacts/` directory. Exit codes: 0 passed, 1 failed, 2 invalid configuration, 130 cancelled. SIGINT/SIGTERM cancel active work and close browsers. Never commit real form data or credentials in exported manifests.

## Distribution and publisher setup

Windows ships as a single portable EXE. Build it on Windows with:

```bash
npm run build:windows
```

Double-click the EXE to launch the app. First opening automatically queues missing browser downloads into persistent app data, with progress and retry in the setup screen. No separate setup EXE or administrator rights are needed. Linux ships as an AppImage; `npm run build:all` cross-builds both releases from Linux using Wine or Docker for Windows.

Set `PROXY_QA_SIGNED_RELEASE=1` and configure electron-builder's Windows signing credentials, such as `CSC_LINK` and `CSC_KEY_PASSWORD`, in release infrastructure to require a signed Windows build. No signing certificate is bundled or generated by this project.

Optional update metadata is embedded at packaging time using `PROXY_QA_UPDATE_FEED` (an HTTPS manifest URL) and `PROXY_QA_UPDATE_PUBLIC_KEY` (an Ed25519 public PEM). The app verifies the manifest signature, refuses version downgrades, and checks the signed artifact size and SHA-256 before exposing a download. Close the app and replace the portable Windows EXE or Linux AppImage with the verified download; local data is retained.

Create a per-platform signed manifest with a publisher-controlled Ed25519 private key:

```bash
QA_RELEASE_PRIVATE_KEY_FILE=/secure/publisher-private.pem \
  node scripts/create-update-manifest.mjs 1.1.0 linux \
  release/Proxy-QA-Browser-1.1.0-x86_64.AppImage \
  https://your-release-host.example/app.AppImage manifest-linux.json
```

Use `win32` and the portable EXE asset for Windows. Host the feed and artifact over HTTPS, and publish the matching public key with the app. Keep the private key and Windows certificate outside the repository. Until configured, the update screen reports that this build has no signed update feed. Native Windows code signing and the update-manifest signature are separate protections.

## Verification

```bash
npm run verify
node scripts/desktop-smoke.mjs
node scripts/first-run-smoke.mjs
node scripts/launcher-ui-smoke.mjs
```

The unit and browser suite covers validation, matrix concurrency and retries, cancellation, budgeting, interruption recovery, scheduling, retention, backup tampering and rollback, gateway credential isolation, report escaping, signed manifests, verified downloads, and a real Chromium form. Linux CI installs Chromium and requires browser tests; both Linux and Windows workflows block on typecheck, lint, and test failures.

The native desktop smoke test uses a temporary app directory and local form server. It exercises scenario creation, CSV import, recorder lifecycle, dataset/suite/environment matrices, visual review/approval/regression, evidence/report export, exported CLI scenario/suite/baseline execution, schedules, policy editing, encrypted backup, update status, and audit history. Screenshots are written to `smoke-output/`. Linux CI runs it under Xvfb. The first-run renderer smoke test simulates Windows IPC responses to check automatic preparation, offline retry, progress, reload behavior, skipped proxy credentials and completed-setup reuse without downloading engines. The launcher UI smoke test checks the full-width URL field, compact profile checkbox, frequent shortcuts, URL reuse from older SQLite history and saved profiles, keyboard interaction, renderer reload and narrow layout. Native Windows packaged smoke testing remains in the Windows workflow, where all three automatic downloads are verified and reused after restart; a Linux host cannot validate native Windows execution or certificate trust.
