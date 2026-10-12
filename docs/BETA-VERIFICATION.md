# Beta readiness verification — 12 October 2026

The working tree includes the bundled demo, repeat-run comparisons and an optional beta-update switch. Public rollout remains pending. The local command-line runtime was Node 26.11.1; `.nvmrc` and GitHub Actions select Node 24. The packaged app uses Electron's embedded runtime.

## Completed checks

| Check | Result | Evidence |
| --- | --- | --- |
| Combined verification | Passed | `QA_REQUIRE_BROWSER_TESTS=1 QA_REQUIRE_DEMO_BROWSERS=chromium,firefox,webkit npm run verify` |
| Desktop tests | 1,577 passed across 95 files | Full suite, including required Chromium, Firefox and WebKit demo integrations and smoke-helper path regression tests |
| Website tests | 101 passed | Documentation, release signatures/storage, channel isolation and existing website behavior |
| Types and lint | Passed | Desktop and website TypeScript; repository ESLint |
| Production builds | Passed | Electron main/preload/renderer, headless-entry dependency checks and Next.js website |
| Packaged Linux demo | Passed, 7 checks | Isolated package under `/tmp/proxy-browser-beta-package`, using its bundled browser |
| Beta update UI | Passed | Real Electron renderer with Windows IPC fixtures; opt-in, reload persistence, beta update action and return to stable |
| Existing desktop automation smoke | Passed | Scenario editing, datasets, recorder lifecycle, suites/environments, visual approval/difference, CLI export, reports, scheduling, policy, backup and audit |
| Existing setup and update UI smoke | Passed | First-run retry/progress/persistence, launcher layout, update notices, restart actions and signature rejection |
| Runtime archive copy | Passed | Real Electron setup preserves ASAR bytes and contents |
| Workflow/issue YAML and whitespace | Passed | YAML parsing and `git diff --check` |

## Verified demo flow

Launch → Try demo → main-process IPC → direct saved profile and seven-step scenario → local bundled form → browser replay → screenshots and SQLite results → JSON/JUnit/HTML exports. A second run compares the same case; an incorrect expected result creates a new failure; restoring it produces a recovery. The recorder opens/closes the practice page. Separate integrations capture real form interactions and replay those recorded steps in all three browser engines. An exported demo also passes through the headless CLI. Reload preserves setup, scenario and history.

The reserved demo address is fulfilled locally. Approved-origin checks remain enforced. The demo uses synthetic values and trace capture is off by default.

## Verified beta behavior

Stable is the initial setting. **Receive beta updates** persists the opt-in and selects a separate signed feed. The signature covers the beta channel; wrong-channel feeds are rejected. Switching clears selected downloads and the sidebar badge, and a stale in-flight result cannot become the new selection. Startup caches are separated by channel. A missing beta release has a clear message. Turning the switch off selects future stable releases without downgrading.

Beta publication uses its own signed pointer and leaves stable publication unchanged. A tampered stable pointer referencing beta is rejected. The release workflow has a manual stable/beta choice and verifies the published signature, version and channel. macOS uses the exact signed beta download URL.

## Original website failures

The original five documentation-sync failures were caused by sandboxed subprocess creation returning `EPERM`, with empty stderr. They passed when subprocess access was available. The helper now checks subprocess errors explicitly, so an execution restriction is reported directly rather than appearing to be a documentation validation defect.

## Native CI follow-up

For commit `d75feec`, [Windows verification](https://github.com/UbaidBinWaris/proxy_browser/actions/runs/38288000892) and [Linux verification](https://github.com/UbaidBinWaris/proxy_browser/actions/runs/38288001233) passed. The [macOS job](https://github.com/UbaidBinWaris/proxy_browser/actions/runs/38288000898) passed tests, arm64/x64 packaging, bundle inspection and the platform smoke test, then timed out in the demo smoke test waiting for Launch.

The failure screenshot showed that completing setup through IPC and reloading preserved the `#/setup` route. It also showed an invalid browser cache directory inside Chromium's macOS `.app` bundle. The demo smoke test now waits for the initial setup screen, completes setup and clicks the available Launch sidebar link after reload. Both desktop smoke scripts find the browser cache above Chromium's revision directory instead of assuming a fixed executable depth. Regression tests cover Apple silicon/Intel bundle paths, Windows, Linux and unknown layouts. Native macOS verification of these fixes remains pending.

The next commit, `e5b854b`, failed typechecking on all three platforms because the new TypeScript regression test imported `smoke-helpers.mjs` without a declaration. Added `scripts/smoke-helpers.d.mts` with the executable-path, optional Node `PlatformPath` and string return types. Full local verification passes with this declaration: desktop and website typechecking, repository lint, 1,577 desktop tests, 101 website tests, Electron builds, headless-entry checks and the Next.js production build. All three native jobs must be rerun after it is pushed.

## Remaining release gates

- Rerun Windows, Linux and macOS CI after the smoke-helper declaration fix is pushed. Windows CI passed for `d75feec`; macOS packaging and platform smoke passed, but the corrected demo smoke still needs native execution. Intel macOS still requires a native device for launch testing.
- Test a real previous-version upgrade and fresh download on beta devices. This local environment has no `/dev/fuse`, so an actual FUSE-mounted Linux AppImage upgrade was not exercised. Unit/update UI checks and unpacked Linux package checks passed.
- Publish a stable release containing the switch and the updated website API, then publish a fresh signed beta version. No public release or server deployment was performed in this session.
- Collect the first 5–10 willing beta users' feedback and measure the five-minute first-success goal. Human beta sessions remain pending.

Local screenshots and machine-readable smoke records are under `smoke-output/` (gitignored), including `beta-updates.png`, `demo-run-comparison.png` and `demo-smoke-linux-packaged.json`.

See [Beta release plan](BETA-PLAN.md) for the tester session and [Publishing beta updates](BETA-UPDATES.md) for rollout instructions.
