# Versioning and USB distribution

This is one desktop app for different Windows, Linux and macOS computers. Each
device keeps its own profiles, settings, credentials and browser downloads.
There is no server or sign-in requirement, and no separate Windows setup
installer. Computer setup and USB/in-app updates below apply to Windows and
Linux; macOS works differently — see [macOS](#macos).

## Set up each computer once

1. Close the older app and open the new Windows EXE or Linux AppImage from USB.
2. Finish browser preparation if this is the device’s first opening.
3. Open **Settings → App & updates** (or click the version in the sidebar).
4. Choose Desktop and Start/Applications menu shortcuts, then click
   **Set up on this computer**.
5. Click **Use computer copy** and use that shortcut for later launches.

Windows stores the extracted program in
`%LOCALAPPDATA%\ProxyQABrowser\Application\Proxy-QA-Browser.exe`.
Launching this copy avoids the portable EXE’s repeated extraction. Linux keeps
a stable AppImage in `${XDG_DATA_HOME:-~/.local/share}/proxy-qa-browser/Application`.
Setup requires no administrator access. Existing data and vault locations
stay unchanged. The previous application folder is retained after an upgrade.

On Windows, **Pin to Start or taskbar** reveals the Start menu shortcut. Use
its right-click menu to pin it, or open **Use computer copy**, right-click the
running taskbar icon and select **Pin to taskbar**. Windows requires the user’s
final pin action; the app does not silently force a pin. See
[Microsoft’s pinning documentation](https://learn.microsoft.com/en-us/windows/apps/develop/windows-integration/pin-to-taskbar).
Linux favorites and desktop-launcher trust prompts depend on the desktop environment.

## What to give users on USB

For Windows, copy:

- `Proxy-QA-Browser-1.2.0-Windows-x64.exe`
- `Proxy-QA-Browser-Update.json`
- `SHA256SUMS-1.2.0.txt` (optional for manual verification)

For Linux, copy the AppImage in place of the EXE. The signed manifest covers
both platforms; only the executable for the user’s computer needs to be present.
Copy all three together into the same USB folder. The previous publisher release
is archived under `release/archive/1.1.0`; leave that archive off customer USBs. The app has a single executable;
the JSON is a small update-verification file.

Users on v1.1.0 must open v1.2.0 directly and set up the computer copy once.
Starting with v1.2.0, future releases can be imported through
**App & updates → Choose USB update**. Select the JSON, review the verified
version and release notes, then click **Restart with v…**. The app verifies
the publisher signature, platform, version, size and SHA-256, copies the update
off USB, and restarts after closing its browser sessions. An existing computer
copy is upgraded at the same path, so shortcuts and pins stay valid. Exception:
1.4.0 changed the app ID. The app rewrites its own Desktop and Start-menu
shortcuts during the update, but Windows taskbar pins made by the user keep the
old ID and open the app as a separate taskbar button: unpin and pin it again
once after updating to 1.4.0.

**Online updates** (**App & updates → Download v… and restart**) follow the same
path: the verified download is staged, the app restarts into it, and the new
version finishes the update. Releases before the 1.4.x fix failed with *"The
update is outside the managed download directory"*; computers on those
versions install the fixed release once by downloading it from the website.

**A portable copy that updates becomes the computer copy.** If the app was run
straight from a downloaded EXE/AppImage (no computer copy yet), the updated
version sets up the computer copy with Desktop and Start/Applications menu
shortcuts, so the next launch opens the new version. If an older EXE/AppImage
is opened later while a newer computer copy exists, the app offers to open the
newer version instead.

On Linux the app starts the new release itself instead of using Electron's
relauncher: the relauncher runs with `no_new_privs`, and an AppImage started
from it cannot mount through FUSE ("Cannot mount AppImage, please check your
FUSE setup"). The new release waits for the old process to exit before it
takes the single-instance lock (`src/main/desktop/restart.ts`).

`node scripts/update-smoke.mjs` tests this end to end with real packaged
builds (old release → signed update → restart → new release finishes); the
deploy workflow runs it on Windows and does not publish when it fails.

**The update result is shown after the restart.** The new version records how
finishing the update went in `last-update.json` next to the pending-update
record (`%LOCALAPPDATA%\ProxyQABrowser\` or `~/.local/share/proxy-qa-browser/`).
On success the app shows *"Updated to v…"* at the top of the window until it is
dismissed. On failure (for example the staged file changed, or the computer
copy could not be replaced) it shows *"Update to v… did not finish"* with a
user-safe reason, **Retry update** (runs the final step again without a new
download) and **Open App & updates**. The running copy stays usable either way,
and a failed update that is only dismissed is retried on the next start.

**Startup update check.** Packaged builds with a signed feed check it once
after the window opens, at most once every 24 hours (Settings → General →
**Check for updates on startup**, on by default). The check only verifies the
signed feed; it never downloads. When a newer compatible release is found, the
version in the sidebar gets an **Update** badge and App & updates shows the
version; **Download v… and restart** stays a deliberate click. Failed checks are
logged and not shown as errors, and the attempt still counts toward the 24 hours.
Builds without a feed (no publisher key at build time) never check. There is no
polling beyond that one check per start.

A release must be newer than the running version. Opening a newer EXE/AppImage
directly also works; click **Update computer copy** afterward. Keep the old app until the new one opens
successfully. Deleting the distribution EXE/AppImage never removes local data.

## Publish the next version

The version belongs to the publisher and is shown read-only in the app.
Use patch versions for fixes, minor versions for compatible features, and
major versions for breaking changes.

```bash
npm run release:version -- patch       # 1.2.0 → 1.2.1
# or: npm run release:version -- minor # 1.2.0 → 1.3.0
# or: npm run release:version -- 2.0.0
```

Then, for a **CI release** (recommended): add notes for the new version to `resources/release-notes.json`, commit, push to `main`, and push the tag `v<version>` — see [SERVER-DEPLOYMENT.md → Releasing](SERVER-DEPLOYMENT.md#releasing). For a **local / USB release**:

1. Add notes for the new version to `resources/release-notes.json`.
2. Run `npm run verify` and the desktop smoke scripts.
3. Build both platforms with `npm run build:all` (Linux + Docker/Wine), or
   build each on its own OS using `build:linux` / `build:windows`.
4. Test Windows using `node scripts/windows-smoke.cjs` on Windows.
5. Run `npm run release:usb` **after both builds finish**. This signs the
   current version’s two binaries and writes the manifest and checksums. Any
   macOS DMG/ZIP files of the same version in `release/` (copied from the Mac
   that ran `npm run build:mac`) are added as optional `macAssets`.
6. Copy the current executable, JSON and checksums to USB. Archive old releases
   separately; never rename an older binary to a newer version.

The version command updates `package.json` and `package-lock.json` together
and rejects lower or inconsistent versions. Keep the package name and app ID
`com.ubaidbinwaris.proxy-qa-browser` stable across releases; changing them can
break existing data paths and pins.

Releases before 1.4.0 used a different app ID. Newer releases accept install
markers, USB manifests and Linux menu entries carrying it (compared by SHA-256
in `src/main/desktop/app-identity.ts`) and replace them on the next setup or
update. Older releases accept only their own ID in **USB** manifests, so while
computers still run 1.3.x and update from USB, build releases with
`PROXY_QA_MANIFEST_APP_ID=<previous app ID>`. Online updates do not check the ID.

## Publisher key

`npm run release:init` creates an Ed25519 key pair once. It has already been
initialized for v1.2.0 in this workspace.

- **Back up `.release-keys/private-key.pem` privately now.** This ignored file
  is required to sign future updates. Never put it on a customer USB or commit it.
- Commit `resources/updates/public-key.pem`; builds embed this public key.
- Keep the same keys for later versions. If the private key disappears, restore
  its backup; the release tool refuses to silently rotate an existing public key.
- USB update signatures authenticate your update packages. Windows Authenticode
  signing is separate; these EXEs are still unsigned unless built with your
  Windows code-signing certificate.

The optional HTTPS update-feed tooling remains available for a future hosted
release feed, but it is unnecessary for this USB workflow.

## macOS

### How the app reaches a Mac

- `npm run build:mac` (on a Mac) produces
  `Proxy-QA-Browser-<version>-macOS-arm64.dmg` / `.zip` (Apple silicon) and
  `…-macOS-x64.dmg` / `.zip` (Intel); `npm run build:mac:dir` only the
  unpacked `.app`. macOS 12 or later. Browsers are not bundled; they download
  on first run into `~/Library/Application Support/proxy-qa-browser/data/browsers`.
- Users open the DMG and drag the app into **Applications** (or
  `~/Applications`). That *is* the computer setup on macOS, so **Set up on this
  computer**, shortcuts, pinning and **Choose USB update** are not offered
  (`DesktopStatus.supported` is false; the IPC calls are refused with an
  explanation).
- **Updates are delivered through the website.** App & updates (and the
  once-per-day startup check) verify the signed feed exactly as on the other
  platforms; when a release lists a macOS download for the Mac's architecture
  (`macAssets`, DMG preferred over ZIP) the app shows **Download vX.Y.Z**, which
  opens `https://<feed origin>/#download`. The user replaces the app in
  Applications; profiles, history and the vault live outside the bundle and
  are kept. The app never downloads the macOS file itself
  (`DesktopStatus.updateDelivery === 'download-page'`; `downloadRelease()`
  refuses with *"On macOS, download the new version from the website…"*).

  Why not an in-app self-update: replacing a running, code-signed `.app`
  bundle in place needs Squirrel.Mac or an equivalent helper, has to keep the
  Developer ID signature, the Gatekeeper quarantine state and App Translocation
  (an app started from Downloads runs from a read-only random path) right, and
  can only be tested on real Macs with a signed build. Until signing and
  notarization exist that path would ship untested; the download page is the
  safe minimum. Electron's relauncher (`app.relaunch`) is the restart plan on
  macOS (`src/main/desktop/restart.ts`) should an in-app path be added later.

### Release manifests with macOS files

macOS downloads travel in an optional `macAssets` list next to `assets` in both
signed manifests (`Proxy-QA-Browser-Update.json` and `update.json`):

```json
{ "assets": [ { "platform": "win32", … }, { "platform": "linux", … } ],
  "macAssets": [ { "platform": "darwin", "arch": "arm64",
                   "fileName": "Proxy-QA-Browser-1.5.0-macOS-arm64.dmg",
                   "size": 123, "sha256": "…", "url": "https://…/api/download/1.5.0/…" } ] }
```

`assets` keeps exactly one Windows and one Linux file, because installed
releases up to 1.4.x parse it strictly (win32/linux only, at most two
entries); they ignore the unknown `macAssets` key, so manifests with macOS
files stay valid for every existing copy. Without macOS files the key is left
out entirely. `scripts/release.mjs` adds whichever
`Proxy-QA-Browser-<version>-macOS-<arm64|x64>.<dmg|zip>` files are in
`release/` (USB/local releases) or passes `platform: "darwin"` entries given to
`createServerReleaseFromMetadata` (CI). The website verifies that both
manifests list the same macOS files, sizes, hashes and URLs, hashes them before
publishing, serves them under `/api/download/…`, and shows a macOS download
card only when a release has them. `node scripts/release-asset.mjs darwin
<arm64|x64> [dmg|zip]` prints the metadata of one built file.

### Code signing and notarization

Nothing Apple-account-dependent is required to build. The macOS settings are
chosen from the environment only (`scripts/mac-signing.mjs`, used by
`electron-builder.config.mjs` for `--mac` builds; Linux and Windows builds
never read these variables):

| Mode | Environment | Result |
| --- | --- | --- |
| Unsigned (default) | none of the variables below | Ad-hoc signature (`identity: '-'`, so Apple silicon runs it), no hardened runtime, not notarized |
| Developer ID signed | `CSC_LINK` (the *Developer ID Application* certificate as `.p12` path, `https://` URL or base64) **and** `CSC_KEY_PASSWORD` | Signed, hardened runtime with `build/entitlements.mac.plist`; not notarized (Gatekeeper still warns on downloaded copies) |
| Signed + notarized | the certificate **and exactly one** complete set: `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (recommended) — or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — or `APPLE_KEYCHAIN`, `APPLE_KEYCHAIN_PROFILE` | Signed, hardened, notarized and stapled by electron-builder (`@electron/notarize`): opens without any Gatekeeper prompt |

The build **fails** instead of silently downgrading when: only one of
`CSC_LINK`/`CSC_KEY_PASSWORD` is set; a notarization set is incomplete (the
error names the missing variables); two notarization sets are present;
notarization credentials are present without a certificate;
`PROXY_QA_SIGNED_RELEASE=1` is set without a certificate *and* notarization;
or an update smoke build (throwaway publisher key) would be signed. This is the
same all-or-nothing rule as the Azure Trusted Signing values for Windows. The
config prints the chosen mode (`macOS signing: unsigned|signed|notarized`).

Entitlements (`build/entitlements.mac.plist`, app and helpers):
`com.apple.security.cs.allow-jit` and
`com.apple.security.cs.allow-unsigned-executable-memory` (V8 on the hardened
runtime) and `com.apple.security.network.client` (only enforced in the App
Sandbox, which the app does not use). Library validation stays on. The
Playwright browsers are separate executables in the app data folder with their
own signatures and need nothing from these entitlements.

### Gatekeeper and unsigned builds

A file downloaded through a browser carries the `com.apple.quarantine`
attribute, so Gatekeeper checks it on first opening:

- **Ad-hoc signed (default) or signed but not notarized:** macOS refuses to
  open it (*"Proxy-QA-Browser cannot be opened because Apple cannot check it
  for malicious software"*; macOS 15: *"Apple could not verify
  'Proxy-QA-Browser' is free of malware"*). The user opens **System Settings →
  Privacy & Security** and clicks **Open Anyway** next to the message, then
  confirms; on macOS 14 and earlier Control-click → **Open** also works. Only
  needed once per copy. Advanced users can instead run
  `xattr -dr com.apple.quarantine /Applications/Proxy-QA-Browser.app`.
- **Builds made on the same Mac** (no quarantine attribute) open directly.
- **Notarized:** opens after the standard "downloaded from the Internet"
  confirmation.

Do not publish ad-hoc builds to end users as the regular download: each
update repeats the Gatekeeper prompt, and the Keychain may ask again for
access to *Proxy-QA-Browser Safe Storage* because the ad-hoc signature changes
with every build (a Developer ID signature keeps the same identity, so the
Keychain grant persists).

### Publishing macOS releases (not enabled yet)

`.github/workflows/macos.yml` builds unsigned apps on `macos-latest` and runs
`scripts/macos-smoke.mjs` on every push to `main` and pull request, but
`deploy.yml` does not build or publish macOS. Once an Apple Developer account
exists:

1. Add environment secrets to *production*: `CSC_LINK` (base64 of the
   Developer ID Application `.p12`), `CSC_KEY_PASSWORD`, and an App Store
   Connect API key (`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, plus the `.p8`
   contents, written to a file in the job and passed as `APPLE_API_KEY`).
2. Add a `macos` job to `deploy.yml` after `preflight` on `macos-latest`
   (pinned `actions/checkout`/`actions/setup-node` as in the other jobs):
   `node scripts/ci-release-version.mjs`, `npm ci`, `npm test`, then
   `PROXY_QA_SIGNED_RELEASE=1 npm run build:mac` with the secrets in `env`,
   `node scripts/macos-smoke.mjs`, `node scripts/release-asset.mjs darwin arm64`
   and `… darwin x64` as step outputs, and transfer both DMGs with `scp` to
   `/var/lib/proxy-browser/staging/<version>/` exactly like the Windows job.
3. Add the job to `publish.needs`, and append
   `{platform:"darwin",arch:"arm64",fileName:…,size:…,sha256:…}` (and x64) to
   the asset list passed to `createServerReleaseFromMetadata`. The website then
   lists the macOS downloads and installed Macs see the update.
4. Update the platform matrix in the README and the website hero text.

## Checks for v1.2.0

The unit suite verifies setup, stable shortcut targets, preservation of data,
upgrade guards, signed update imports, changed USB files, wrong keys/platforms,
relaunch environment cleanup, and version/key tooling. The native Electron UI
smoke covers setup retry, pin instructions, rejected updates, verified previews,
restart actions, cancellation and narrow layouts. The packaged Linux smoke additionally opens the real installed AppImage and
checks its saved profile, completed setup and bundled browsers. The Windows CI smoke also
creates and resolves a real Start menu shortcut, then opens the stable copy
and checks that prepared browsers and SQLite history remain available.

Native Windows pinning and EXE execution still require validation on a Windows
computer; Linux and simulated Windows UI results do not prove those OS actions.
