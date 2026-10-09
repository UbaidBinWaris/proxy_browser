# Desktop QA automation

This edition stays local: no sign-in, shared server, cloud account, or remote worker is required. Workspaces organize projects on one installation. Local audit records describe changes made through the app; they are not authenticated-user records or tamper-proof compliance evidence.

## Start a regression suite

1. Create a saved browser profile in **Profiles**. Select direct routing or a proxy provider whose keys are saved in **Manage proxy keys**.
2. Open **QA automation**, choose or create a workspace, and select **New scenario**.
3. Choose a base profile, enter the starting URL, and add actions and assertions. The starting URL's origin is approved by default; add other approved origins explicitly when using navigation steps.
4. Select **Run matrix**, choose installed browsers and compatible devices, and optionally add DataImpulse locations. The runner refuses unsupported browser/device combinations and direct-connection location tests before creating a batch.
5. Inspect **Results** for each combination, failure details, console errors, failed HTTP requests, step screenshots, and retry counts. Export JSON, JUnit XML, or standalone HTML reports.

Supported steps: navigate, fill, click, select, check, uncheck, upload file, switch to page (main page or a pop-up), compare screenshot, expect visible, expect text, expect URL contains, and expect navigation HTTP status, plus the compliance, accessibility and performance checks described in [Compliance, accessibility and performance checks](#compliance-accessibility-and-performance-checks). Action steps (fill, click, select, check, uncheck, upload) can run inside an iframe; see *Frames, pop-ups and file uploads*. Text, visibility, and URL assertions wait within the configured step timeout. Each case and retry uses a fresh browser context and a temporary profile, without modifying the saved base profile. The temporary profile is deleted when its attempt finishes.

Automation runs headlessly. Manual sessions continue using the existing Launch and Sessions screens. There is one active automation batch per installation; cases within that batch run concurrently up to the local policy limit. A failed case can be retried at most twice. Retrying repeats all actions, including submissions: use dedicated test environments and synthetic data. JSON retains every attempt's evidence; a passing case with retries is identified in the results screen.

### Record actions

In the scenario editor, enter a starting URL and choose **Record actions**. A separate visible browser opens with a temporary profile. Interact with your test form, then choose **Stop recording** in the app and **Use recorded steps**. Review the steps, add expected-result assertions, and save. The recorder captures text inputs, single-select choices, checkbox changes, button/link clicks and file choices; repeated typing in the same field becomes one fill step. Password fields and elements marked `data-qa-sensitive` are excluded, in frames and pop-ups too. Only real user input is recorded: events a page script dispatches are ignored. Recording is a draft in memory until you save it.

The main page, its iframes and its pop-up windows are recorded when every document involved is on an approved origin: an action inside an iframe gets the iframe's selector path, and an action in a pop-up is preceded by a **Switch to page** step. Frames from unapproved origins are never loaded (see *Origin isolation*), and an event from such a frame is not recorded; the recording notes say so. For a file choice the recorder stores only the sanitized file name, never the file or its path: attach the fixture file in the editor before saving (see below). Shadow DOM, rich-text editors, drag-and-drop uploads, more than 9 pop-ups, frames nested more than 5 levels deep and special keyboard gestures need manual or future actions. HTTP document redirects follow the same isolation rules as automation. Closing the recording browser stops capture. Starting a test or a scheduled run while recording is refused; changing editor/workspace or cancelling the editor stops recording. Use synthetic data: ordinary text inputs are recorded as entered. A classic (non-JavaScript) multipart form post made while recording can reach the server without the chosen file's content in Chromium and WebKit; automated runs send fixtures in full.

### Frames, pop-ups and file uploads

- **Frames.** Fill, click, select, check, uncheck and upload steps take an optional frame path: the CSS selectors of the iframe elements from the page down to the frame, separated by ` >> ` in the editor (for example `iframe#checkout >> iframe.card-number`, at most 5 levels). Before acting, the runner resolves each iframe and checks that the frame's document is on an approved origin. A step targeting a frame from an unapproved origin fails with `The frame <selector> is on an unapproved origin (<origin>), so steps cannot run inside it.` instead of timing out; the run also reports the blocked frame navigation. Self-healing fallbacks work inside frames. Assertions run on the page itself, not inside frames.
- **Pop-ups.** Pop-up windows and new tabs the run opens are numbered in opening order: `popup:1` to `popup:9`. A **Switch to page** step waits (within the step timeout) for that pop-up to open and load, and later steps, including assertions and navigation, run there until another **Switch to page** selects `main` or a different pop-up. Pop-ups are routed by the same approved-origin guard as the main page: a pop-up that tries to open an unapproved origin is blocked before any request reaches it. Console errors and failed requests of pop-ups are part of the case evidence.
- **File uploads.** An **Upload file** step sets one or more of the scenario's **upload fixtures** on a file input. Fixtures are stored inside the scenario itself (base64), so exports and CI manifests are self-contained and no host path is ever read during a run. In the editor, **Attach fixture file** opens a file dialog in the app's main process, which reads the chosen file once, checks it and returns only its content and sanitized name; the editor never handles a file path. Limits: 5 fixtures, 2 MB each, 6 MB per scenario (so a scenario manifest stays under the CLI's 10 MB limit). Allowed types: png, jpg/jpeg, gif, webp, pdf, txt, csv, json, xml, rtf, doc/docx, xls/xlsx, odt and ods. Names are reduced to letters, digits, `.`, `_` and `-` with a lowercase extension, so `My CV (final).PDF` becomes `My_CV__final_.pdf`; the server receives that name. At run time each fixture is written to the attempt's private evidence folder (owner-only permissions) for the browser and deleted when the attempt ends.

**Upload fixtures are test data.** They travel with the scenario into scenario and suite exports, CI manifests and encrypted configuration backups, and anyone who can read those can read the files. Use synthetic files only: never real CVs, IDs, invoices or other personal documents. Removing a fixture from a scenario does not remove it from exports or backups made earlier.

### Self-healing selectors

Pages change: an `id` gets renamed and a recorded `#submit-btn` stops matching. When the recorder captures a click, fill, select, check, uncheck or upload step, it also stores up to four **fallbacks** for that element, most stable first: a test ID (`data-testid`, `data-test` or `data-qa`), the ARIA role with its accessible name, the associated label text, the placeholder, short visible text for buttons and links, and a CSS path. Fallbacks never contain field values; password fields and `data-qa-sensitive` elements are not recorded at all. The editor shows how many fallbacks each step has. For a step inside a frame, the fallbacks are looked up inside that frame.

During a run the primary selector is tried first, exactly as before. Only when it matches **no element at all** does the runner try the fallbacks in order, and it accepts one only when it matches **exactly one** element (and, for a role fallback, an element with that role). An element that exists but is hidden or disabled is a real failure and never heals. The primary selector and the fallbacks share the step timeout: the primary gets the first 60% to appear, the fallbacks the rest, so healing never lengthens a step. **Assertions and navigation never heal** — healing an expected-result check could hide a real bug.

Choose the behaviour with **Self-healing** in the scenario editor:

- **Off** — fallbacks are ignored; a selector that matches nothing fails the step.
- **Warn** (default) — the step runs on the fallback and passes; the case is flagged **Healed** in Results and reports.
- **Fail** — the step fails without acting, and the message names the suggested replacement selector.

In **Results**, a healed step shows a **Healed** badge (or **Healing blocked** in fail mode) with the original and suggested selectors. Review the step's screenshot, then choose **Update selector in scenario**: the suggested selector becomes the step's primary selector, and the old one is kept as its first CSS fallback. The update uses the saved scenario's own fallback and is refused if the scenario changed since that run. Suggested selectors for roles, labels and text use Playwright's exact `internal:role`, `internal:label` and `internal:text` selectors; test IDs and placeholders use plain CSS. Scenarios saved before this feature have no fallbacks and behave as before; their mode defaults to warn.

JSON reports include each healed step's original selector, the fallback used and the suggested selector, plus the batch's `healedSteps` count. JUnit adds a `healed` property and a `system-out` line per healed step; HTML shows a **Healed** badge. The CLI accepts `--healing off|warn|fail` to override every scenario in a manifest; without it, the manifest's value (or warn) applies.

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

### Compliance, accessibility and performance checks

**Checks** are assertion steps that inspect the page your scenario has reached and record evidence. Like other assertions they **never heal**. They only read what your own page renders and loads (scrolling the checked element into view is the one interaction); they never contact a third-party service, never change the browser's identity, and never try to get past bot protection. If protection blocks your QA runs, allowlist them with a [site access token](#site-access-tokens-in-automation).

| Step (editor label) | What it asserts | Main fields (default) |
| --- | --- | --- |
| `checkConsent` (Check consent disclosure) | The consent/TCPA disclosure is present, worded as approved, visibly rendered, large enough, legible and near the submit button | `blockSelector` or `blockText`; `approvedText` (optional, `{{variables}}` allowed); `wordingMatch` (`exact`); `minFontPx` (10); `minContrastRatio` (4.5); `nearSelector` (optional); `maxDistancePx` (200) |
| `checkConsentCheckbox` (Check consent checkbox) | The consent checkbox is **not pre-checked** and has a label | `checkboxSelector` |
| `checkScriptLoaded` (Check script loaded) | A lead-certificate script loaded and did its work | `preset`: `trustedform`, `jornaya` or `custom`; `scriptUrl`, `inputSelector`, `globalName` (optional overrides; `scriptUrl` required for custom) |
| `checkAccessibility` (Check accessibility (axe)) | No axe-core violations at or above an impact | `scopeSelector` (whole page); `tags` (`wcag2a`, `wcag2aa`); `failOn` (`serious`); `maxNodes` (5) |
| `checkPerformance` (Check performance budget) | Page metrics are within budget; all metrics are always recorded | `budgets` (`lcpMs`, `cls`, `inpMs`, `tbtMs`, `ttfbMs`, `domContentLoadedMs`, `loadMs`, `transferBytes`; none by default); `settleMs` (1000) |

Every check also accepts `continueOnFailure`: when set, a failed check records its evidence, marks the case failed, and lets the remaining steps run, so one run reports every problem on the page. Without it a failed check stops the case like any other assertion. A check can also end as **WARN**: recorded in results and reports, but not failing (for example "contrast not measurable").

All check fields are optional additions to the step format, so scenarios, configuration backups and CI manifests saved before checks existed load unchanged. Selectors, `blockText`, `approvedText`, `scriptUrl` and `inputSelector` accept `{{variables}}`, resolved during preflight like other steps.

#### Consent disclosure (`checkConsent`)

1. **Present.** The block is found by CSS selector, or by a distinctive phrase (`blockText`, the smallest element containing it), within the step timeout. When several elements match, the first is checked and a warning says so.
2. **Wording.** The block's rendered text (`innerText`) is compared with `approvedText` after normalizing whitespace (including non-breaking and zero-width spaces) and Unicode composition. Punctuation, quotes and case must match: they are part of the approved wording. `exact` requires equal text; `contains` allows other text around the approved wording. A mismatch fails with a word-level diff, e.g. `… may [-call and text-] {+contact+} me …` (`[-…-]` approved but missing, `{+…+}` only on the page); JSON keeps the diff as `wordingDiff`.
3. **Visible.** The block is scrolled into view (instantly, centred), then fails when it or an ancestor is `display:none`, it has `visibility:hidden`, its combined opacity is below 0.1, it has no size, it is clipped away by `overflow`, `clip` or `clip-path: inset()`, it is still outside the viewport (e.g. `left:-9999px`), or **another element covers its centre** (a modal, sticky footer or cookie banner). The covering element is named in the evidence.
4. **Font size.** The smallest rendered font size of the block's visible text, in CSS pixels (CSS transforms included), must be at least `minFontPx`. The evidence quotes the smallest text run.
5. **Contrast.** For each visible text run, the text colour is composited over the background colours of its ancestors down to the white page canvas (semi-transparent and transparent layers blend; element opacity fades the text) and the WCAG 2 contrast ratio is computed. The lowest ratio must be at least `minContrastRatio`. When a background image or gradient is behind the text, or a colour is outside sRGB (e.g. `oklch()`), the ratio is **not measurable**: the step records a warning instead of passing, so verify those manually. The single threshold has no large-text exception; set 3 for disclosures that are WCAG large text.
6. **Near.** With `nearSelector`, the gap between the two boxes must be at most `maxDistancePx`.

The matrix headline names what failed, e.g. `consent font 9px`, `consent contrast 2.31:1`, `consent hidden (display:none)` or `consent wording differs`. Limitations: overlap is tested at the centre only; a background painted by a non-ancestor (an absolutely positioned sibling) is not seen by the contrast measurement; frames and shadow DOM are not searched.

#### Consent checkbox (`checkConsentCheckbox`)

Place it **before** any step that checks the box. It fails when the box is checked (`checked`, or `aria-checked="true"` for a `role="checkbox"` element), when the element is not a checkbox, or when it has no label (a `<label>`, `aria-label`, `aria-labelledby` or `title`). A box that the HTML marks checked but a script unchecked is a warning.

#### Lead-certificate scripts (`checkScriptLoaded`)

The check waits up to the step timeout for the page's own script to finish:

- **TrustedForm** — a script from `api.trustedform.com` (or a subdomain) and a hidden input whose name contains `TrustedFormCertUrl` holding a `https://cert.trustedform.com/…` certificate URL.
- **Jornaya LeadiD** — a script from `create.lidstatic.com` and the hidden input `#leadid_token` populated.
- **Custom** — a script URL pattern (`*` matches anything; a pattern without `*` or a scheme matches anywhere in the URL), plus an optional populated input (CSS selector) and/or an initialized global (dotted name such as `vendor.ready`).

"Loaded" means a completed script download in the page's resource timing, or a matching script element whose input/global effect is present. The token or certificate value is **never recorded**, only whether it is populated and its length. The runner never calls these services; the page's own script contacts its vendor exactly as it would for a visitor, so use the vendor's test or staging configuration where it offers one.

#### Accessibility (`checkAccessibility`)

Runs [axe-core](https://github.com/dequelabs/axe-core) (bundled, MPL-2.0) in the page's main frame with the chosen rule tags (`wcag2a`, `wcag2aa`, `wcag21aa`, `wcag22aa`, `best-practice`, …), optionally scoped to one element. Violations at or above `failOn` (`minor` < `moderate` < `serious` < `critical`) fail the step; lower ones are a warning. Evidence lists each violation's rule id, impact, help text and link, the number of failing elements and up to `maxNodes` element selectors. Frames are not scanned. Automated rules find a subset of WCAG issues; they do not replace a manual review.

#### Performance (`checkPerformance`)

When a scenario contains this step, the runner installs performance observers before the first navigation, so every document of the case is measured from its start. The step waits for the `load` event (within the step timeout), waits `settleMs` more, then reads the **current** document's metrics:

| Metric | Source | Availability |
| --- | --- | --- |
| LCP | Largest Contentful Paint entries | Chromium, Firefox, WebKit (Playwright 1.63 builds) |
| CLS | Layout-shift entries, largest session window | Chromium |
| INP | Event Timing: the slowest interaction (needs a click or key press in an earlier step) | Chromium, Firefox, WebKit |
| TBT | Long tasks after first contentful paint, time beyond 50 ms | Chromium |
| TTFB, DOMContentLoaded, load | Navigation Timing | All (WebKit reports no TTFB for documents the runner fetches) |
| Transfer size | Navigation + resource timing (cross-origin resources without `Timing-Allow-Origin` count as 0) | All |

A metric over its budget fails the step (equal passes); a budgeted metric the browser does not report is a warning, never a pass. TTFB includes the runner's origin-guard fetch of the document, so compare budgets between runs of this tool rather than with field data.

**Network throttling.** Set **Network throttling** in the scenario editor (`"networkProfile": "slow-3g" | "fast-3g" | "4g"` in JSON) to emulate the Chrome DevTools presets for every case. It uses the Chromium DevTools protocol and applies to Chromium-family engines only; other engines run unthrottled, the case notes say `network throttling … not supported on webkit`, and performance checks show a warning. Subresources (scripts, images, API calls) are throttled; the document itself is fetched by the origin guard and is not.

#### Results and reports

Each check step stores its outcome and evidence as `check` in the step result, and each case lists its checks as `checks` (`{ index, action, status, headline }`). **Results** shows a summary above the matrix with every failed or warning check, e.g. `Apple iPhone SE (3rd gen) · WebKit · Texas: consent font 9px FAIL`, a badge per check in each case, and the evidence under each step. JSON exports contain everything; JUnit adds a `check` property and a `Check …` system-out line per check; the HTML report adds a compact **Checks** table (device · browser · location, step, check, result, detail).

#### Pre-launch consent QA workflow

Run this before a lead form goes live, and after every change to its disclosure, layout or vendor scripts:

1. **Use staging and synthetic data.** Point the scenario at a staging or pre-launch environment (an [environment](#suites-and-environments) makes the switch explicit), and submit only synthetic test leads that your systems tag as tests, so nothing is sold, dialled or counted. Checks themselves do not submit anything; a scenario that also tests submission should end on staging.
2. **Build the scenario.** Navigate to the form; add `checkConsentCheckbox` before any step that ticks the box; add `checkConsent` with the disclosure selector, the wording approved by your compliance team in `approvedText`, and `nearSelector` set to the submit button; add `checkScriptLoaded` for TrustedForm and/or Jornaya; add `checkAccessibility` scoped to the form. Turn on **Continue if this check fails** for each check to collect every problem in one run.
3. **State-specific wording.** Put each state's approved disclosure in a dataset variable (`{"disclosure": "…"}`) and use `{{disclosure}}` as the approved text; each dataset row runs separately and is named in results.
4. **Run the matrix.** Choose the devices your traffic uses (a small phone such as iPhone SE, a large Android phone, a tablet, a desktop), the engines (Chromium, WebKit / Safari-compatible QA, Firefox) and, for location-dependent pages, the states the campaign targets through verified proxy locations. Small screens are where disclosures get covered by sticky buttons or shrink below the minimum size.
5. **Review and fix.** The summary lists each failing combination, e.g. `Apple iPhone SE (3rd gen) · WebKit · Texas: consent font 9px FAIL`. Fix the page, run again, and export the HTML report for the record or JUnit for CI (`--healing` does not apply to checks).

These checks automate repeatable parts of compliance QA; they are not legal advice and do not decide whether a disclosure is sufficient. Approved wording, placement rules and consent requirements come from your counsel.

Example (CLI manifest scenario steps):

```json
[
  { "action": "checkConsentCheckbox", "checkboxSelector": "#tcpa-consent", "continueOnFailure": true },
  {
    "action": "checkConsent",
    "blockSelector": "#tcpa-disclosure",
    "approvedText": "{{disclosure}}",
    "nearSelector": "#submit",
    "minFontPx": 10,
    "minContrastRatio": 4.5,
    "continueOnFailure": true
  },
  { "action": "checkScriptLoaded", "preset": "trustedform", "continueOnFailure": true },
  { "action": "checkAccessibility", "scopeSelector": "form", "failOn": "serious", "continueOnFailure": true },
  { "action": "checkPerformance", "budgets": { "lcpMs": 2500, "cls": 0.1, "tbtMs": 300 } }
]
```

### Origin isolation

Document navigation is restricted to the approved origins. **HTTP document redirects are followed only while every hop stays on an approved origin** (for example `POST /submit → 303 /thanks`, `/start → 302 /form`, or `http://` → `https://` of the same site when both origins are approved — a different scheme or port is a different origin). Playwright only routes the first request of a redirect chain, so the runner fetches each document with redirects disabled and decides every hop itself:

- **Approved target:** the browser makes a fresh navigation to it, which is checked again from scratch and keeps the cookies the redirect set. 301/302/303 continue as a `GET`, as in every browser. A 307/308 of a form `POST` is re-sent with the same method and body only within the same origin; the page then keeps the submitted URL in the address bar. A cross-origin 307/308 `POST` is blocked, even to an approved origin.
- **Unapproved target:** the run fails with `Navigation to an unapproved origin (<origin>) was blocked (HTTP <status> redirect).` before any request reaches that origin.
- **Loops:** a chain stops after 10 redirects and the run fails.
- **Evidence:** each case records every hop in `redirects` (status, redacted from/to URLs, `blocked` when refused), and each step records the hops seen while it ran. The JSON export contains both; the HTML report lists each hop under the case (`Redirect step 2 (click): 303 … → …`, blocked hops marked), and JUnit adds a `redirect` property and a `system-out` line per hop.
- **Status assertions:** after each step the runner waits until a navigation it started, and any redirect chain it is following, reaches its final page, so `assertStatus` checks the **final** document (`/start → 302 → /form` asserts `200`, not `302`; a click on a link to `/start` does the same). Before `assertStatus`, it also waits briefly (up to 0.5 s) for a navigation the previous action scheduled from a script timer.

To restore strict blocking of every document redirect, turn off **Follow redirects within approved sites** in the scenario editor (stored as `"followRedirects": false`). The field is optional and absent means follow; saving in the editor keeps the stored value. The form's ordinary scripts, images, and API resources can still request other origins; this is a navigation boundary, not a complete network-egress firewall. Arbitrary user-supplied JavaScript actions are not supported.

### Site access tokens in automation

If your own site's WAF, CAPTCHA or fraud scoring blocks QA runs, allowlist the runs on that site rather than evading the protection: configure a secret header in **Settings → Advanced → Site access tokens** and accept it on your staging host (WAF skip rule for that header, CAPTCHA vendor test keys, and tag submissions carrying it as test leads so they are never sold or counted). Enabled tokens are routed into every automation and recorder context of the desktop app and sent only to the exact origins they list. A followed redirect is a fresh navigation, so it carries the header only when its own origin is listed; the header is never re-sent across a redirect and never reaches an unapproved origin. Each case's results record `notes` such as `site access token "Staging" applied to https://staging.example.com` — never the value. Raw traces record request headers, so while any token is enabled an opt-in trace is skipped and the case notes say so. Tokens are per device: they are not included in configuration backups, scenario/suite exports or the CI command-line runner, which therefore runs without them. See the README section *Site access tokens (allowlisting your own QA traffic)* for matching rules and limits.

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

For a ready-made Docker image (browsers included) and a reusable GitHub Action, see [CI runner](CI-RUNNER.md).

Use **Export for CI** on a scenario, then run:

```bash
npm run build
npm run qa -- --config /path/to/scenario.json --output qa-results
```

The manifest contains `scenario`, `profile`, and optionally `matrix`. The optional matrix accepts `engines`, `devices`, `targets`, `concurrency`, and `retries`; the runner supplies its own scenario identifier, so a matrix needs no `scenarioId` (one written by an older export is accepted and ignored). Suites use **Export suite for CI**, which includes their scenarios, profiles and workspace environments. To choose an exported environment or compare approved screenshots:

```bash
npm run qa -- --config suite.json --environment "Staging" --output qa-results
npm run qa -- --config scenario.json --baselines approved.qavb --output qa-results
npm run qa -- --config scenario.json --healing fail --output qa-results
```

`--healing fail` is useful in CI when any healed selector should block a merge until the scenario is updated; see [Self-healing selectors](#self-healing-selectors).

Environment names must be unique in the exported manifest. The CLI uses the exported environment settings; it never resolves desktop IDs directly. One optional custom gateway from environment variables applies to the entire CLI run. Imported baselines are temporary copies, and missing/changed comparisons exit with a test failure.

Install the required browser engines before running. The CLI uses a temporary in-memory database and fresh contexts, never the desktop's credential vault. Its browser downloads are not automatic.

Proxy credentials for profiles that use a built-in proxy provider come from these variables (set the secret ones through CI secrets):

| Variable | Meaning |
| --- | --- |
| `QA_PROVIDER` | Provider id, e.g. `dataimpulse`. Must match the provider named by the manifest's proxied profiles (profiles exported by v1.3.0 name none and are DataImpulse profiles) |
| `QA_PROVIDER_PRODUCT` | Product key, e.g. `residential` or `mobile`. Default: the product of the first proxied profile in the manifest |
| `QA_PROVIDER_HOST`, `QA_PROVIDER_PORT` | Gateway; default: the provider's documented gateway (DataImpulse: `gw.dataimpulse.com`, `823`) |
| `QA_PROVIDER_USERNAME`, `QA_PROVIDER_PASSWORD` | Login (secret) |
| `QA_PROVIDER_EXTRA_<KEY>` | Provider-specific credential fields, e.g. a zone (`<KEY>` matches the field key case-insensitively; secret fields are redacted like passwords) |

`DATAIMPULSE_PROXY_HOST`, `DATAIMPULSE_PROXY_PORT`, `DATAIMPULSE_PROXY_USERNAME` and `DATAIMPULSE_PROXY_PASSWORD` remain supported as an alias for `QA_PROVIDER=dataimpulse`; when any `QA_PROVIDER*` variable is set they are ignored (with a warning). Incomplete or invalid `QA_PROVIDER*` variables, or credentials for another provider than the manifest's profiles use, exit with code 2 naming the variables (never their values). Manifests exported by v1.3.0 (proxy modes `dataimpulse-sticky` / `dataimpulse-rotating`) load unchanged.

For a custom gateway, provide `QA_PROXY_SERVER` and, for HTTP authentication, `QA_PROXY_USERNAME` and `QA_PROXY_PASSWORD`. Custom gateway credentials override profile routing. No `.env` file is loaded, and every credential variable (logins, passwords, `QA_PROVIDER_EXTRA_*`) is removed from the process environment before browsers launch.

Configuration errors name the failing field and the reason, e.g. `QA configuration error: Invalid manifest: matrix.engines.0: Invalid option: …`; values from the manifest or the environment are never echoed.

Outputs: `results.json`, `results.xml` (JUnit), `results.html`, and an `artifacts/` directory. Exit codes: 0 passed, 1 failed, 2 invalid configuration, 130 cancelled. SIGINT/SIGTERM cancel active work and close browsers. Never commit real form data or credentials in exported manifests.

## Distribution and publisher setup

Windows ships as a single portable EXE. Build it on Windows with:

```bash
npm run build:windows
```

Double-click the EXE to launch the app. First opening automatically queues missing browser downloads into persistent app data, with progress and retry in the setup screen. No separate setup EXE or administrator rights are needed. Linux ships as an AppImage; `npm run build:all` cross-builds both releases from Linux using Wine or Docker for Windows.

Windows releases are signed with **Azure Trusted Signing** when `PROXY_QA_AZURE_SIGN_ENDPOINT`, `_ACCOUNT`, `_PROFILE` and `_PUBLISHER` are set (in CI: the `AZURE_SIGN_*` and `AZURE_*` secrets, see [SERVER-DEPLOYMENT.md → Windows code signing](SERVER-DEPLOYMENT.md#windows-code-signing-optional-recommended-before-public-releases)); `PROXY_QA_SIGNED_RELEASE=1` then refuses an unsigned build. No signing certificate is bundled or generated by this project.

Update metadata is embedded at packaging time: the feed URL from `PROXY_QA_UPDATE_FEED` (an HTTPS manifest URL; defaults to the project's release server) and the Ed25519 publisher key from `resources/updates/public-key.pem`. The app verifies the manifest signature, refuses version downgrades, and checks the signed artifact size and SHA-256 before installing. Users update from **App & updates → Download v… and restart**; local data is retained. See [DISTRIBUTION.md](DISTRIBUTION.md) for the update flow.

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
