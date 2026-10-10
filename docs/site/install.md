# Install

Download and run Proxy QA Browser on Windows, Linux or macOS; there is no installer and no administrator rights are needed.

## Choose a download

Downloads are on the [download page](/#download). Each release ships one file per platform. The files contain no proxy credentials and no personal data, so you can share them with colleagues; each person enters their own proxy keys on first run.

| Platform | File | Browser engines | Updates |
| --- | --- | --- | --- |
| Windows 10/11 x64 | `Proxy-QA-Browser-<version>-Windows-x64.exe` (portable) | Downloaded on first run (about 400 MB) | In the app, online or from USB |
| Linux x86-64 | `Proxy-QA-Browser-<version>-x86_64.AppImage` | Chromium, Firefox and WebKit built in | In the app, online or from USB |
| macOS 12+ arm64 / x64 | `Proxy-QA-Browser-<version>-macOS-arm64.dmg` / `-macOS-x64.dmg` (unsigned) | Downloaded on first run | The app checks; you download from the website |

> **Note:** the macOS downloads are free, unsigned DMGs: ad-hoc signed and not notarized, because the project has no Apple Developer account yet. They are built and smoke-tested on a Mac in CI for every release. macOS blocks them the first time; step 2 of [macOS](#macos) shows how to open them once.

The download page also lists the SHA-256 checksum of each file.

## Windows

1. Copy `Proxy-QA-Browser-<version>-Windows-x64.exe` anywhere: Desktop, Downloads or a USB stick.
2. Double-click it. If the EXE is not code-signed, Windows SmartScreen shows *"Windows protected your PC"*. Click **More info**, then **Run anyway**. Some antivirus products are also cautious with unsigned portable EXEs; restore the file or add an exception if needed.
3. The portable EXE unpacks itself to `%TEMP%` on every start, so the window takes a few seconds to appear. For faster later starts, open **Settings → App & updates** and click **Set up on this computer**. This creates a stable local copy with Desktop and Start menu shortcuts. See [Updates](/docs/updates#the-computer-copy).
4. On first opening the setup wizard downloads the missing browser engines (Chromium is required; Firefox and WebKit are optional). An internet connection is needed once. See [First run](/docs/first-run).

Microsoft Edge, which ships with Windows, is detected automatically. Only one copy of the app runs at a time: starting it again brings the open window to the front.

Your data lives in `%APPDATA%\proxy-qa-browser` and the vault key in `%LOCALAPPDATA%\ProxyQABrowser\keys`, so moving or deleting the EXE loses nothing.

## Linux

1. Make the file executable and run it:

   ```bash
   chmod +x Proxy-QA-Browser-<version>-x86_64.AppImage
   ./Proxy-QA-Browser-<version>-x86_64.AppImage
   ```

2. AppImages mount themselves with **FUSE 2**. If you see `dlopen(): error loading libfuse.so.2`, install it, or run the AppImage with `--appimage-extract-and-run`:

   | Distribution | Command |
   | --- | --- |
   | Arch | `sudo pacman -S fuse2` |
   | Ubuntu 24.04 | `sudo apt install libfuse2t64` |
   | Older Debian / Ubuntu | `sudo apt install libfuse2` |

3. The AppImage is self-contained. Chromium, Firefox and WebKit are inside, together with the libraries WebKit needs on other distributions. Nothing is downloaded and no system packages are needed for the browsers.

**glibc requirements.** The app, Chromium and Firefox need glibc 2.25 or newer. The bundled WebKit needs **glibc 2.38 or newer** (Ubuntu 24.04+, Debian 13+, Fedora 39+ or a current Arch). On older distributions Chromium and Firefox work but WebKit does not start.

Your data lives in `~/.config/proxy-qa-browser` and the vault key in `~/.local/share/proxy-qa-browser/keys`.

## macOS

macOS 12 (Monterey) or later. The DMG is unsigned, so macOS asks you to allow it in **System Settings → Privacy & Security → Open Anyway**, once per downloaded copy (again after each update, because Mac updates are new downloads). Use the `-macOS-arm64` file for Apple silicon (M1 and later) and `-macOS-x64` for Intel Macs.

1. Open the DMG and drag **Proxy-QA-Browser** into **Applications** (or `~/Applications`). There is no installer and the app never asks for an administrator password.
2. **Gatekeeper.** A build without Apple credentials is only ad-hoc signed and not notarized. A downloaded copy is then refused with *"cannot be opened because Apple cannot check it for malicious software"* (macOS 15: *"Apple could not verify…"*). Open **System Settings → Privacy & Security**, scroll to the message about Proxy-QA-Browser and click **Open Anyway**, then confirm. On macOS 14 and earlier, Control-click the app and choose **Open** also works. This is needed once per copy. A build you made yourself on the same Mac opens directly; a signed and notarized build opens without the prompt.
3. On first opening the browser engines download into `~/Library/Application Support/proxy-qa-browser/data/browsers`. An internet connection is needed once.
4. The first time the vault key is created or read, macOS may ask whether *Proxy-QA-Browser* may use the *Proxy-QA-Browser Safe Storage* Keychain item. Choose **Always Allow**.

Installed browsers in `/Applications` or `~/Applications` (Chrome, Edge, Brave, Opera, Opera GX, Vivaldi, Chromium) are detected automatically. Closing the window quits the app, as on Windows and Linux.

Your data lives in `~/Library/Application Support/proxy-qa-browser` and the vault key in `~/Library/Application Support/ProxyQABrowser-keys`.

## Starting from an editor's terminal

Terminals inside Electron-based editors (VS Code, Cursor and others) often export `ELECTRON_RUN_AS_NODE=1`. The app then behaves like plain Node.js and **no window opens**. Start it without that variable:

```bash
env -u ELECTRON_RUN_AS_NODE ./Proxy-QA-Browser-<version>-x86_64.AppImage
```

Double-clicking the file in a file manager is not affected.

## Move to another computer

Install the app on the new computer and run the first-run setup, including your proxy credentials. The vault cannot be decrypted on another machine, because its key is tied to the machine and OS user and is deliberately stored apart from the vault.

To keep profiles and run history:

1. Close the app on both computers.
2. Copy `<userData>/data/proxy-qa.sqlite` (and the `screenshots` folder if you want the images) into the new `<userData>/data/`.
3. Start the app. Saved browser paths repair themselves on the next detection.

If you copy the whole `<userData>` folder instead, expect the *"Vault could not be decrypted"* warning and re-enter your keys. `<userData>` locations are listed in [Security and privacy](/docs/security-and-privacy#data-locations).

## Uninstall

Close the app, then delete:

| What | Windows | Linux | macOS |
| --- | --- | --- | --- |
| Program | the downloaded `.exe` | the downloaded `.AppImage` | the app in Applications |
| Data, vault, database, downloaded engines, app-installed browsers | `%APPDATA%\proxy-qa-browser` | `~/.config/proxy-qa-browser` | `~/Library/Application Support/proxy-qa-browser` |
| Vault key, computer copy and update records | `%LOCALAPPDATA%\ProxyQABrowser` | `~/.local/share/proxy-qa-browser` | `~/Library/Application Support/ProxyQABrowser-keys` and `~/Library/Application Support/ProxyQABrowser` |

If you set up a computer copy, also delete its Desktop shortcut and its Start menu or applications-menu entry. Browsers installed with winget on Windows stay installed; remove them in Windows **Settings → Apps** if you no longer want them.

Deleting only the vault key or `install.json` makes the stored credentials unreadable; deleting `<userData>` starts the first-run setup again.

## Common questions

### Why does macOS say the app can't be opened?

The DMGs are free but unsigned: ad-hoc signed and not notarized by Apple. Gatekeeper therefore refuses each downloaded copy, including every update, until you allow it as in step 2 of [macOS](#macos).

## Next step

Continue with the [first-run setup](/docs/first-run).
