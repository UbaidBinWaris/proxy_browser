# Security and privacy

How Proxy QA Browser protects your proxy credentials, what it stores and where, and which network connections it makes.

There is no account, no telemetry and nothing is uploaded. Everything the app records stays on your computer. The website's own data practices are described in the [Privacy policy](/privacy). To report a vulnerability, see [Security](/security).

## Credential vault

Proxy logins are stored **encrypted, per computer and per operating-system user**.

- The vault file is `<userData>/vault/proxy-credentials.vault`, encrypted with **AES-256-GCM** (random 12-byte IV, 16-byte tag). Its header is authenticated, so a vault cannot be moved to another installation.
- It holds one entry per provider product: host, port, username, password, optional session template and any provider-specific extra fields. Extra fields are encrypted exactly like passwords.
- Writes are atomic, and a save reads the vault back and verifies it before reporting success.

### The vault key

The 256-bit vault key is never stored in clear. The key file `<installId>.key` holds it **wrapped** by one of two backends, and the app shows which one is in use:

| Backend | Used when | Label |
| --- | --- | --- |
| Operating system keychain | Windows; macOS; Linux with a real keyring (GNOME Keyring / libsecret or KWallet) | *Windows DPAPI (current user)*, *macOS Keychain*, *GNOME Keyring / libsecret*, *KWallet* |
| Machine-derived | No usable keychain (Linux `basic_text` or `unknown` backends are rejected because they offer no protection; a locked or denied macOS Keychain) | *machine-derived key (no OS keychain found — reduced protection)* |

The machine-derived key is derived with scrypt from the machine ID and the OS user name, salted with the install ID. Anyone who can read the key file **and** knows those values can recover it. Install and unlock a keyring, restart, and use **Rotate key** to upgrade.

The key directory is deliberately **outside** the user data folder, so copying the profile folder does not copy the key:

| Platform | Key directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\ProxyQABrowser\keys` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/proxy-qa-browser/keys` |
| macOS | `~/Library/Application Support/ProxyQABrowser-keys` |

On Linux and macOS, key and vault files are owner-only (`0600`, directories `0700`). Windows relies on the per-user profile permissions.

### Security health

**Settings → Advanced → Proxy keys → Security health** shows *Healthy*, *Reduced protection*, *No vault yet* or *Attention needed*. **Details** lists key protection, whether the key and vault are present, whether the vault decrypts, permissions, the install ID and timestamps, with **Re-check** and **Rotate key**.

- The check is local and uses no network. The app never tests the proxy at start-up, because that would spend your quota.
- **Rotate key** writes a new key next to the old one, re-encrypts and verifies, then swaps. An interrupted rotation is recovered on the next start.
- A vault that cannot be decrypted (for example after copying it to another computer) shows *"Vault could not be decrypted with the current key — re-enter the proxy credentials"*; the app still starts.

### Vault upgrades and downgrades

Version 1.4.0 moved the vault to a per-provider format. Before rewriting an older vault, the app copies it, still encrypted, to `proxy-credentials.vault.v2.bak` in the same folder. If the copy or the rewrite fails, both files are left as they were and the problem is shown in Security health.

Versions older than 1.4.0 cannot read the new vault. To go back, close the app and copy `proxy-credentials.vault.v2.bak` over `proxy-credentials.vault` (keys saved after the upgrade are lost), or re-enter the keys in the older version. The backup only restores if **Rotate key** has not been used since the upgrade.

## What is never logged or stored

- The **password is write-only**. It is never sent to the screen, never written to the database, logs or `install.json`, and never stored unencrypted. The app's window only receives host, port, a masked username (`ab****yz`) and where the credentials come from.
- Every password is registered with the **log redactor** the moment it is loaded, saved or tested. Every log line and every error shown in the window passes through it: registered values become `[REDACTED]`, and credential shapes such as `scheme://user:pass@host`, `Authorization` and `Proxy-Authorization` headers and `password=…` are scrubbed even when the exact value is unknown.
- **Targeting strings** such as `cr.us;state.newjersey;sessid.…` are not secrets and are stored; logins are not.
- Browser processes and installers never inherit proxy credentials from the environment.
- The **network inspector** stores method, URL, status, timing, resource type and extracted IDs. JSON response bodies (up to 512 KB) are inspected in memory for IDs and never stored. Captured URLs mask known sensitive query parameters and drop fragments.

Other evidence, such as screenshots, QA results and optional Playwright traces, is stored as ordinary local files, not in the encrypted vault. Treat them as sensitive if your forms show personal data, and use synthetic test data. See [Scenarios and matrices](/docs/automation#privacy-of-evidence).

## Electron hardening

- Every app window uses context isolation, the Chromium sandbox, no Node.js integration and web security. The window can only call a fixed, typed set of functions; every call is validated in the main process.
- A strict Content Security Policy applies to the app's pages. `window.open` is denied and navigation away from the app is blocked.
- Screenshots are served only from the screenshot folder. **Reveal** buttons only open the app's own data, screenshot, key and vault folders, and the only external pages the app opens are the vendor browser download pages and, on macOS, the update download page.
- The [Manage keys window](/docs/first-run#the-manage-keys-window) adds content protection, an inactivity timeout and no developer tools in packaged builds.

## Local relay for WebKit

Playwright's WebKit cannot open HTTPS connections through a proxy that requires a password. For WebKit sessions the app starts a small relay on `127.0.0.1` with a random port (loopback only) that adds the proxy login and forwards to the gateway. WebKit is given only the local address, so the credentials never reach the browser process. Each session has its own relay, closed with the session. Chromium and Firefox authenticate to the proxy directly.

## Network connections

The desktop app only talks to:

| Destination | When |
| --- | --- |
| The selected proxy provider's gateway (for example `gw.dataimpulse.com:823`) | Proxy tests, exit-IP checks and all traffic of proxied browser sessions |
| The selected IP-check service (ip-api.com, ipinfo.io or ipwho.is) | Every exit-IP check, through the proxy or directly for Direct sessions; one fallback service on failure |
| The start URL and your form | Browser sessions and QA runs |
| Playwright's browser download CDN | Downloading the bundled engines (Windows, macOS, development) |
| Vendor sites (`dl.google.com`, `packages.microsoft.com`, `repo.vivaldi.com`, `deb.opera.com`, GitHub for Brave, winget sources) | One-click browser installs |
| The vendor download page, in your default browser | **Get Browser** buttons |
| The publisher's signed update feed | The startup update check (at most once per 24 hours), **Check for updates** and update downloads |

Location search uses the bundled GeoNames data and never leaves the computer.

> **Note:** Proxy gateways are HTTP proxy endpoints and the default `ip-api` service uses plain HTTP on its free tier. HTTPS pages stay encrypted end to end through the proxy, but the proxy login itself travels to the gateway as the provider's protocol requires. Choose `ipinfo` or `ipwhois` under **Settings → Advanced → IP verification** if you prefer an HTTPS lookup service.

## Data locations

`<userData>` is `%APPDATA%\proxy-qa-browser` on Windows, `${XDG_CONFIG_HOME:-~/.config}/proxy-qa-browser` on Linux and `~/Library/Application Support/proxy-qa-browser` on macOS. The exact paths are listed under **Settings → App & updates → Locations**.

| What | Location |
| --- | --- |
| Encrypted vault | `<userData>/vault/proxy-credentials.vault` |
| Vault key | The key directory above |
| Install ID, setup state, last gateway test (no secrets) | `<userData>/install.json` |
| Database: profiles, runs, proxy sessions, network capture, settings, logs, QA automation | `<userData>/data/proxy-qa.sqlite` |
| Screenshots | `<userData>/data/screenshots/` |
| Log files (`app-YYYY-MM-DD.log`, JSON lines, redacted) | `<userData>/data/logs/` |
| Downloaded browser engines | `<userData>/data/browsers/` (inside the AppImage on Linux, read-only) |
| Vendor browsers installed by the app (Linux) | `<userData>/data/installed-browsers/<engine>/` |
| Site access tokens (values encrypted with the OS keychain) | `<userData>/data/site-access-tokens.json` |
| Open sessions, browser version cache, task history, last update check | `<userData>/data/live-sessions.json`, `engine-versions.json`, `task-history.json`, `update-check.json` |
| Last update result | `%LOCALAPPDATA%\ProxyQABrowser\last-update.json` or `~/.local/share/proxy-qa-browser/last-update.json` |
| Recent and favorite devices, recent locations, last Launch form | The app's local storage inside `<userData>` |

The database keeps the latest 5,000 log rows. Deleting a profile deletes its proxy session row; its runs are kept. Delete runs on their run page. Screenshots stay on disk until you delete them.

## Sharing and backups

- The downloaded EXE, AppImage and DMG contain no credentials or personal data.
- **Encrypted configuration backups** from QA automation exclude proxy credentials and site access tokens. See [Scenarios and matrices](/docs/automation#backup-and-diagnostics).
- **Export diagnostics** writes redacted information only; review the file before sharing it.
- Never include real proxy credentials, cookies or personal data in issue reports; use placeholders such as `brd-customer-EXAMPLE`.

Anyone who can log in as your operating-system user on that computer can, in principle, use the app with your saved keys. Protect your OS account.
