# Critical form automation

Use one reviewed scenario per form, with synthetic data in a staging or other approved test environment. The browser cannot guarantee undetectability, acceptance by third-party protection, or the absence of every possible error. Strict execution makes observed failures stop the runner instead of allowing the next action.

## Configure each form

1. Record and review its actions. Approve the origins required for document navigation, frames and pop-ups. Page resources and API calls use their normal origin rules; third-party scripts remain enabled.
2. Add **Check script loaded** for every required vendor. Where supported, check the initialized global or populated hidden field, including consent/lead certificates. Set the timeout to the form's documented readiness window. A successful load does not establish that the provider accepted the submission.
3. Add checks for the site's required disclosures and consent controls before submitting.
4. End the actions with an assertion for the site's actual acceptance confirmation. Strict mode requires a text, visibility, URL or screenshot assertion after the last action. Choose a selector or message unique to successful acceptance. A generic page heading, HTTP 200 or finished click is insufficient evidence of acceptance.
5. Enable **Strict form execution** and set matrix **Retries** to **0**. It refuses page/console/network errors, unexpected field states, browser validation failures and selector healing. Check steps stop on failure even when their continuation option is set. Existing scenarios keep their previous behavior until the switch is enabled.
6. Review each result and reconcile accepted submissions with the site's records. If a request was sent but no confirmation arrived, its outcome is unknown; check those records before rerunning. This mode cannot undo a submission or deduplicate manual reruns, matrix cases or schedules. Use the site's idempotency mechanism where available.

## Verify before using a form

Exercise the following with synthetic data and controlled failures:

- Required and invalid fields, field values rewritten by handlers, masked inputs, dropdowns and consent controls.
- Slow initialization, missing vendor scripts, page exceptions, console errors, failed resources and HTTP 403/429/5xx responses.
- Expired sessions, custom validation errors and delayed or incorrect success messages.
- Multi-step pages, approved frames/pop-ups, blocked navigation and changed or ambiguous selectors.
- A submission accepted by the server whose response or confirmation is lost. Confirm that automatic retry is refused and the run is reviewed before repetition.

State verification is performed immediately after an action; later asynchronous updates require explicit form-specific checks. A required script's readiness should be checked before entering data. Native HTML validation checks do not replace custom server or frontend validation. Optional resources that emit errors can fail a strict run too.

## Protection access

Keep vendor scripts working normally and arrange the site's approved automation/testing access. The app already supports [site access tokens](site/site-access-tokens.md) for exact origins agreed with the owner. A site's permission to fill a form and a vendor's automation access can be separate. Owner approval on one origin does not configure another provider's rules.

Real form URLs, required script identities, success criteria and access configuration have not been supplied for this implementation. Compatibility with those forms remains unverified; configure and test each when that information is available.

## Verification — 13 October 2026

Full local verification passed: 1,629 desktop tests across 96 files, 101 website tests, desktop/website typechecks, lint, Electron/headless-entry builds and the Next.js production build. Strict-form browser regressions ran in Chromium, Firefox and WebKit against synthetic local forms. They cover successful submission, HTTP 403/429/503, script/console/network failures, discarded input values, changed selections, browser validation, blocked pop-ups, healing refusal, check failure and missing confirmation after an accepted submission. Unit checks cover confirmation requirements, export/editor persistence and refusal of matrix/suite retries.

The built Linux source app passed eight desktop demo checks, including enabling and saving the strict switch, disabled healing, a successful strict replay, recorder lifecycle, CLI export/replay, reports and reload persistence. Screenshot: `smoke-output/qa-strict-editor.png`; verification log: `/tmp/proxy-browser-strict-final-verify.log`. Native Windows/macOS execution of this change remains for CI.
