# Troubleshooting

Common problems with installing, launching, proxies and browsers, and what every error code means.

Details of any failure are in **Settings → Advanced → Logs**. When you report a problem, include the error code and the redacted message, never real credentials. Issues are tracked on [GitHub](https://github.com/UbaidBinWaris/proxy_browser/issues).

## Installing and starting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Windows: *"Windows protected your PC"* | The EXE is not code-signed | Click **More info**, then **Run anyway** |
| Windows: antivirus quarantines or slows the EXE | Unsigned portable EXEs that unpack themselves to `%TEMP%` look suspicious to some scanners | Restore the file or add an exception for it |
| Windows: the window takes several seconds to appear | The portable EXE unpacks itself on every launch | Use **Settings → App & updates → Set up on this computer**, then start the computer copy |
| Linux: `dlopen(): error loading libfuse.so.2` | FUSE 2 is missing | Install `fuse2`, `libfuse2t64` or `libfuse2`, or run with `--appimage-extract-and-run`. See [Install](/docs/install#linux) |
| Linux: AppImage fails with a `chrome-sandbox` or namespace error | Unprivileged user namespaces are disabled | Enable them, for example `sudo sysctl kernel.unprivileged_userns_clone=1` where that setting exists, or your distribution's AppArmor or userns setting |
| Linux: WebKit does not start, Chromium and Firefox do | glibc older than 2.38 | Use a newer distribution (Ubuntu 24.04+, Debian 13+, Fedora 39+) or another engine |
| macOS: *"cannot be opened because Apple cannot check it"* | The build is not notarized | **System Settings → Privacy & Security → Open Anyway**. See [Install](/docs/install#macos) |
| macOS: Keychain asks for *Proxy-QA-Browser Safe Storage* | The vault key is protected by the Keychain | Choose **Always Allow**. Unsigned builds may ask again after each update |
| No window opens; Node-style output in the terminal | `ELECTRON_RUN_AS_NODE` is set (editor terminals) | Start with `env -u ELECTRON_RUN_AS_NODE …` |
| Online update fails with *"The update is outside the managed download directory"* | A bug in releases before the 1.4.x fix | Download and open the current release from the website once |
| After updating to 1.4.0, a taskbar pin opens a second taskbar button | 1.4.0 changed the app ID | Unpin and pin the app again once |

## Proxy and location

| Symptom | Cause | Fix |
| --- | --- | --- |
| `PROXY_AUTH_FAILED` / HTTP 407 | Wrong username or password, inactive plan, or the plan does not allow the requested option | Re-enter the keys in **Manage keys** (the message names the provider), click **Test connection**, then **Save encrypted**. Check the plan in your provider account |
| `PROXY_NOT_CONFIGURED` / pool shows **Not set up** | No login saved for that provider product (DataImpulse Mobile needs its own Mobile-plan login), or the provider does not offer that product | **Manage keys** → the provider → the product's tab → enter and save |
| `PROXY_DEAD` with *"…no exit IP available… (HTTP 503)"* | The gateway has no free exit IP for this new sticky session and location (typical for thin ZIP codes) | Launch again later (about 30 minutes), use rotating mode, or target the city or state. See [ZIP targeting caveat](/docs/locations-and-devices#zip-targeting-caveat) |
| `PROXY_DEAD` / `PROXY_TIMEOUT` (other) | Gateway unreachable, port blocked, exit node offline | **Test** the product under **Settings → Advanced → Proxy keys**; check firewall and VPN; rotate the session; raise the IP-check timeout |
| `DNS_FAILURE` | The gateway host or start URL does not resolve | Check the proxy host in **Manage keys**, the start URL and your DNS |
| `IP_VERIFY_FAILED` | The IP-check service failed or answered unexpectedly | Pick another **Provider** under **Settings → Advanced → IP verification**, or raise timeout and retries |
| Location badge **Mismatch** or **Partial** | The exit IP geolocates elsewhere (carrier IPs, thin pools) | Use **Same state** or **Exact** with more **Attempts**, or a broader target. The run's warning says which IP was used |
| Targeted launches refused or more expensive than expected | DataImpulse state, city and ZIP targeting needs a country and is billed at 2×; unusual spellings are refused | Keep **Remove spaces (DataImpulse default)** encoding and confirm your plan allows geo targeting |
| A community-verified provider refuses a parameter | The dialect was written from documentation, not tested with a live account | Check the provider docs linked from the keys window and [open an issue](https://github.com/UbaidBinWaris/proxy_browser/issues) with the redacted error |
| `INVALID_INPUT` *"… uses the proxy provider "x", which this version does not support"* | The profile, backup or CLI manifest names a provider this build does not include | Edit the profile and pick a provider, or use a version that includes it |

## Browsers

| Symptom | Cause | Fix |
| --- | --- | --- |
| `BROWSER_MISSING` (Chromium, Firefox or WebKit) | The engine is not downloaded yet (Windows, macOS) | **Settings → Browsers → Install**. The AppImage never needs this |
| `BROWSER_MISSING` (Chrome, Edge, Brave, Opera, …) | The browser was not found | **Install** or **Get**, then **Re-detect**, or **Set custom path** to the real binary |
| Linux install fails: *"Unpacking this package needs the "xz" tool…"* | `xz` is missing | Install `xz` (`xz-utils` on Debian and Ubuntu) and **Retry** |
| Windows install fails with a winget error | Outdated winget sources, a declined UAC prompt (Chrome), or no App Installer | Run `winget source update`, retry and accept the prompt, or use **Get** |
| Task fails with *"Installed, but failed verification: …"* | The browser installed but the headless test launch failed | Read the reason in **Tasks** and **Retry**. For Vivaldi this is expected |
| Vivaldi launches fail after 45 seconds | Vivaldi does not support automation | Use another browser |
| `ENGINE_BUSY` | That browser is being installed or uninstalled | Wait for the task in **Tasks**, or cancel it |
| Phone or tablet presets are greyed out for Firefox | Playwright Firefox cannot emulate mobile devices | Use WebKit or a Chromium-family browser |

## Sessions and pages

| Symptom | Cause | Fix |
| --- | --- | --- |
| `SESSION_LIMIT` / *"A session is already open"* | **One session at a time** is on | **Close it and launch**, terminate the session on **Sessions**, or turn the setting off |
| `SITE_TIMEOUT` | The start URL did not load in time | Raise **Navigation timeout (ms)** under **Settings → Advanced → Network inspector**; check proxy latency |
| `SITE_HTTP_ERROR` | The page answered with HTTP 400 or higher | Check the URL; the window stays open for inspection |
| `SSL_ERROR` | Invalid TLS certificate | Check the domain; try Direct to rule out the proxy |
| Your own WAF or CAPTCHA blocks test runs | Bot protection on your site | Allowlist your QA traffic with a [site access token](/docs/site-access-tokens); do not try to evade it |

## Vault

| Symptom | Cause | Fix |
| --- | --- | --- |
| *"Vault could not be decrypted with the current key"* | Key file replaced, vault copied from another computer, keyring changed, `install.json` recreated, or an older version opening a vault this version upgraded | Re-enter and save the credentials. After a downgrade, restore the backup; see [Vault upgrades and downgrades](/docs/security-and-privacy#vault-upgrades-and-downgrades) |
| `VAULT_ERROR` *"The credential vault could not be upgraded … backup … .v2.bak"* | The one-time vault upgrade could not write the backup or the new file (disk full, permissions) | Free space or fix permissions on the vault folder and restart. The old vault and its backup are untouched and the keys keep working meanwhile |
| Security health shows *Reduced protection* | No usable OS keychain (Linux without GNOME Keyring or KWallet) | Install and unlock a keyring, restart, then **Rotate key** |

## QA automation and CI

| Symptom | Cause | Fix |
| --- | --- | --- |
| *"Navigation to an unapproved origin (…) was blocked"* | A step or redirect left the approved origins | Add the origin to the scenario's approved origins if it is yours. See [Origin isolation](/docs/automation#origin-isolation) |
| **No approved visual baseline** | First run of a **Compare screenshot** step | Review the screenshot in **Results** and click **Approve baseline** |
| A step passes but the case is marked **Healed** | The primary selector no longer matches | Review and click **Update selector in scenario**. See [Self-healing selectors](/docs/self-healing) |
| CLI exits with code 2 | Invalid manifest, flags, environment name or proxy variables | Read the message; it names the field or variable. See [CI runner](/docs/ci-runner#outputs-and-exit-codes) |
| A consent check shows WARN *contrast not measurable* | A background image, gradient or non-sRGB colour is behind the text | Verify the contrast by hand. See [Checks](/docs/checks#consent-disclosure-checkconsent) |

## Error codes

| Code | Meaning |
| --- | --- |
| `PROXY_NOT_CONFIGURED` | No credentials for the selected provider product, or the provider does not offer it |
| `VAULT_ERROR` | Vault key or vault file missing, corrupt or not decryptable, or the vault upgrade failed |
| `PROXY_AUTH_FAILED` | The proxy rejected the credentials (HTTP 407) |
| `PROXY_TIMEOUT` | The proxy did not answer in time |
| `PROXY_DEAD` | Could not connect through the gateway, or it refused the session (HTTP 502, 503 or 504) |
| `DNS_FAILURE` | A host name could not be resolved |
| `IP_VERIFY_FAILED` | The IP-check service failed or returned an unexpected answer |
| `BROWSER_MISSING` | The selected browser is not installed |
| `BROWSER_LAUNCH_FAILED` | The browser could not start, or not within 45 seconds |
| `SITE_TIMEOUT` | The start URL did not load within the navigation timeout |
| `SITE_HTTP_ERROR` | The start URL answered with HTTP 400 or higher |
| `SSL_ERROR` | TLS certificate problem |
| `INVALID_PROFILE` | The profile cannot be launched as configured, or already has an open session |
| `INVALID_INPUT` | A value failed validation |
| `NOT_FOUND` | The record does not exist |
| `SESSION_CLOSED` | The browser session is already closed |
| `SESSION_LIMIT` | Another session is open while single-session mode is on (MCP server: the daily budget is used up) |
| `ENGINE_BUSY` | The browser is being installed or uninstalled |
| `INTERNAL` | Anything else; details are in **Settings → Advanced → Logs** |
