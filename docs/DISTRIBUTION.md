# Versioning and USB distribution

This is one desktop app for different Windows and Linux computers. Each device
keeps its own profiles, settings, credentials and browser downloads. There is
no server or sign-in requirement, and no separate Windows setup installer.

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

A release must be newer than the running version. No background network update
checks are needed. Opening a newer EXE/AppImage directly also works; click
**Update computer copy** afterward. Keep the old app until the new one opens
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

Then:

1. Add notes for the new version to `resources/release-notes.json`.
2. Run `npm run verify` and the desktop smoke scripts.
3. Build both platforms with `npm run build:all` (Linux + Docker/Wine), or
   build each on its own OS using `build:linux` / `build:windows`.
4. Test Windows using `node scripts/windows-smoke.cjs` on Windows.
5. Run `npm run release:usb` **after both builds finish**. This signs the
   current version’s two binaries and writes the manifest and checksums.
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
