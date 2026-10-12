# Publishing opt-in beta updates

Users opt in under **Settings → App & updates → Receive beta updates**, then use the existing update button. Switching back selects future stable releases without downgrading the installed app. The choice is saved locally; no signup or proxy plan is required.

## Release process

The next desktop release is **2.0.0**, including strict form execution, the bundled demo, run comparisons and the beta switch. Changing the package version prepares that release; it does not publish a beta. The strict mode works in either channel when the installed build includes it. Configure it per scenario as described in [Critical form automation](CRITICAL-FORM-AUTOMATION.md).

Use tag `v2.0.0` to publish exactly 2.0.0 to stable through the existing tagged-release workflow. A manual run on this source with `channel: beta` publishes a distinct **2.0.x** version using the run-number scheme below. Verify native checks first and keep stable and beta version directories distinct.

1. Publish a stable build that contains the switch, and deploy the website code containing `/api/updates/beta`. Existing installed versions must update to that stable build before they can see the switch.
2. Add release notes and ensure native build/smoke workflows pass. Open **Build and deploy browser releases → Run workflow**, choose **beta** for `channel` and the intended source branch.
3. The normal jobs build every platform, run the same checks, sign both manifests with `channel: "beta"`, deploy the website and publish the beta pointer. Read-back verification checks the signature, version and channel.
4. Verify the beta feed and try the update from a client with the switch enabled. Stable clients and the public home-page downloads continue to use the stable pointer.

Tags remain stable releases. Manual CI releases retain the existing numeric patch-plus-run-number scheme. Both channels use `major.minor.patch` versions, and a version directory is immutable across channels. Publish a fresh version for each release; move the next stable release above the beta sequence to allow beta users to return through the updater. This implementation does not support a rollback to an older stable executable.

## Local metadata and publisher configuration

For the existing local publisher workflow, set `PROXY_QA_RELEASE_CHANNEL=beta` when running `npm run release:server` or `npm run release:usb`. The channel is covered by the publisher signature; the server refuses a pair whose signed channels differ. No private signing keys are needed on the download server.

The standard desktop feed `/api/updates/stable` derives `/api/updates/beta` on the same origin. If you use a custom stable feed path, configure `PROXY_QA_BETA_UPDATE_FEED` when packaging. Both feeds must be HTTPS and on the same publisher origin.

The stable pointer remains `current.json`; beta uses `current-beta.json`. `/api/releases?channel=beta` returns beta metadata, and the authenticated admin inventory includes `betaRelease`. Publishing a beta verifies the same filenames, sizes, checksums, signatures and URLs as stable. A channel switch invalidates any selected download and clears the sidebar badge; startup caches are separate. An unpublished beta is displayed as “No beta release is published yet.”

On macOS, the update button opens the exact asset URL from the signed beta manifest. It does not send the user to the stable download section. The user replaces the app in Applications as in the existing macOS update workflow.

See [Beta release plan](BETA-PLAN.md) for the tester session and [Server deployment](SERVER-DEPLOYMENT.md) for credentials and publisher infrastructure.
