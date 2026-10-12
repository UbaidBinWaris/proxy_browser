# Beta release plan

Goal: a new QA user can install the app, run the bundled demo and export an understandable report within five minutes after a browser is ready. Browser download time is measured separately.

## Release gates

Run `npm ci`, `npm ci --prefix app/webapp` and `npm run verify` with Node 24 (`.nvmrc`). Subprocesses and local browser launches must be permitted. A sandbox `EPERM` is an environment failure, not evidence of broken documentation; docs-sync tests now report subprocess errors explicitly.

On Linux, install the browser dependencies with `npx playwright-core install --with-deps chromium firefox webkit`, then run `QA_REQUIRE_BROWSER_TESTS=1 QA_REQUIRE_DEMO_BROWSERS=chromium,firefox,webkit npm test`. CI requires every demo engine; a missing browser fails instead of silently skipping it.

After `npm run build`, run `npm run smoke:demo` (or `xvfb-run -a npm run smoke:demo` on a headless Linux runner). The test uses temporary application data and synthetic values, and writes screenshots plus a JSON verification record under `smoke-output/`. It exercises Launch → demo → replay → reports → second run → controlled failure → recovery → recorder start/stop → exported CLI replay → reload. Real captured interactions and replay/failure checks run separately in Chromium, Firefox and WebKit integration tests.

Native Windows and macOS build workflows also run `node scripts/demo-smoke.mjs --packaged` after building. On Linux, the same script accepts `--packaged` for `release/linux-unpacked` or `--executable /absolute/path/to/proxy-qa-browser` for an isolated build. Cross-built artifacts do not substitute for native test results.

Before distributing a beta, record results for each platform:

| Platform | Install/setup | Demo + recording | Reports/comparison | Upgrade + data reuse | Result |
| --- | --- | --- | --- | --- | --- |
| Windows 10/11 x64 | Pending native run | Pending native run | Pending native run | Pending native run | Pending |
| Linux x86-64 | Pending beta device | Pending beta device | Pending beta device | Pending beta device | Pending |
| macOS Apple silicon | Pending native run | Pending native run | Pending native run | Pending native run | Pending |
| macOS Intel | Pending native device | Pending native device | Pending native device | Pending native device | Pending |

Test a fresh download and a previous-version upgrade on each available native platform. Confirm that a failed update leaves the old app usable, and that saved scenarios/profiles remain after a successful update. Existing update-smoke and platform-smoke scripts cover portions of this story; record the actual native/manual outcome before calling a platform verified.

## Open beta through the update switch

Anyone can join by enabling **Settings → App & updates → Receive beta updates** and using the update button. There is no account, invitation or signup requirement. Stable is the default channel. Collect feedback from the first 5–10 willing testers as the initial usability sample.

First publish a stable build containing the switch and the updated website API. Then publish a separate signed beta through **Build and deploy browser releases → Run workflow → channel: beta**. Beta publication changes `current-beta.json` and `/api/updates/beta`; it does not replace the stable download or stable update feed. The release workflow retains the build and smoke-test gates for both choices.

Both channels use unique numeric `major.minor.patch` versions for compatibility with the existing updater. Never reuse a published version. Returning from beta selects future stable updates and does not downgrade the installed app. Plan the next stable version above the beta versions (for example, a 1.5.x beta series followed by stable 1.6.0). Manual CI deployments retain the existing patch-plus-run-number version scheme.

## Initial tester sample

Ask willing beta users who regularly test their own forms to complete the session: a mix of manual QA, automation users and developers, covering the supported operating systems. Start with the bundled demo, then a synthetic staging form they own. Collect feedback before adding another major feature. Optional invitations are an owner action; the update switch is the public entry point.

Use this message when ready:

> I’m testing a beta of Proxy QA Browser. Could you spend 20 minutes installing it, running the bundled demo and trying one form on your own staging site? I’m looking for confusing steps and failures. Please use synthetic data and share only redacted evidence. I’ll send the exact version and download link after the release checks pass.

## Tester session (20 minutes)

1. Record operating system, architecture, app version and whether the machine is a fresh installation or upgrade.
2. Start a timer at first launch. Finish setup without proxy credentials. Record browser download time separately.
3. On Launch, choose **Try demo**. Under **QA automation → Scenarios**, choose **Try demo → Start matrix**. Record time to the first passed result and any help needed.
4. Export a JSON or HTML report. Explain what was tested and where the evidence is stored.
5. Choose **Edit → Record actions**. Enter Demo User, demo@example.test, pick Team, check consent and submit. Stop recording, use recorded steps, add an assertion that `#result` contains `Demo account ready.`, save and replay.
6. Run twice. Change the final expected text to an incorrect value, run again, restore it and rerun. Find the new failure and recovery in Results.
7. Close and reopen the app. Confirm the saved scenario and history remain.
8. Optionally repeat on a staging form they own, with their own proxy plan if location testing is relevant.

## Feedback and decisions

Use the **Beta feedback** issue template. Capture time to first successful run, the exact step where help was needed, severity, expected/actual result and reproducible steps. Ask which single improvement would make the tool useful in their usual QA workflow. Keep credentials, real form values, cookies and unreviewed traces out of issues.

During the first week, prioritize installation failures, crashes, lost data, misleading test outcomes and blocked core workflows. During the second week, improve the most common setup and report-understanding problems, then repeat the same session on the revised build.

Exit criteria: no unresolved crashes/data loss in the tested core workflow; all available native release gates pass; at least 80% of testers reach a passed demo without help within five minutes after browser readiness; every critical finding has a reproducible case and a verified fix. Publish a version only after recording these results.
