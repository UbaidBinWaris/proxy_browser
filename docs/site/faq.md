# FAQ

Short answers to the questions people ask most often about Proxy QA Browser.

## General

### Is there a paid edition?

No. Proxy QA Browser is free for everyone and open source under the [Apache License 2.0](https://github.com/UbaidBinWaris/proxy_browser/blob/main/LICENSE), with no account. You pay your proxy provider for your own plan if you use one.

### What may I test with it?

Only forms, funnels and sites that you own or are explicitly contracted to test, with a proxy plan you are entitled to use. See [Responsible use](/docs/introduction#responsible-use) and the [Acceptable use policy](/acceptable-use).

### Can it get past bot detection, CAPTCHA or fraud checks?

No, and it is not meant to. The app does not spoof fingerprints, solve CAPTCHAs or imitate human input to avoid detection, and such features are out of scope for the project. If your own site's protection blocks your QA runs, allowlist your test traffic with a [site access token](/docs/site-access-tokens), CAPTCHA test keys or an allowlisted staging environment.

### Does it send any data to the developer?

No. There is no telemetry and nothing is uploaded. The app contacts your proxy gateway, the IP-check service, the sites you test, browser download sources and the signed update feed. See [Network connections](/docs/security-and-privacy#network-connections).

### What works without a proxy plan?

Direct launches and QA automation runs without location targets work on your own connection. Only location targeting, including location cases in a QA automation matrix, needs a plan. See [Proxy providers](/docs/proxy-providers).

### Which proxy providers are supported?

DataImpulse (live-tested) and Bright Data, Oxylabs, Decodo and IPRoyal (community-verified: written from their official documentation, not tested with a live account). QA automation (not manual launches) can also use any HTTP or HTTPS gateway, or an unauthenticated SOCKS5 gateway, as a [custom gateway](/docs/proxy-providers#custom-gateways-qa-automation).

### Does location search cover other countries?

Only by country: country targeting accepts any two-letter country code, for [testing your site from other countries](/use-cases/location-testing). State, city and ZIP search covers the United States only.

## Using the app

### What is the bundled WebKit?

The open-source engine Safari is built on, not Apple Safari itself. It is useful for catching WebKit-specific layout and behaviour issues, but it is not a substitute for testing in real Safari when that matters. See [cross-browser testing with WebKit](/use-cases/cross-browser-testing).

### Which browsers can use phone and tablet presets?

WebKit and Chromium-family browsers; Playwright Firefox has no mobile emulation. See [phone and tablet presets per browser](/use-cases/device-testing).

### Does an installed browser use my own profile, bookmarks or extensions?

No. Every launch uses a fresh temporary profile. Your own bookmarks, cookies and extensions are never touched.

### Is the reported exit-IP location always exact?

No. IP geolocation is a third-party estimate, some ZIP codes have very few exit IPs, and carrier IPs often geolocate to the carrier's hub; the [ZIP targeting caveat](/docs/locations-and-devices#zip-targeting-caveat) lists what to do.

### Can I run several browsers at once?

Yes. Turn off **Settings → General → One session at a time**. One profile can still have only one open session.

### Does it check TCPA consent disclosures?

Yes, as QA aids. The consent disclosure check tests presence, approved wording, visibility, font size, contrast and distance to the submit button against thresholds you set. The consent checkbox check fails if the box is pre-checked or unlabelled, a rule you can require in your QA. They are not legal advice and do not decide whether a disclosure is sufficient. See [Checks](/docs/checks).

### Can an AI assistant run checks with it?

Yes. The `qa-mcp` server lets Claude Code, Cursor or another MCP client run device-aware checks, with navigation limited to the origins you allowlist. It ships with the source code and the runner Docker image, not with the desktop download, and location checks need proxy credentials passed as environment variables. See [MCP server](/docs/mcp-server).

### Where are my screenshots and run history?

On your computer, in the app's data folder. See [Data locations](/docs/security-and-privacy#data-locations).

## Security

### Is my proxy password safe?

It is encrypted with AES-256-GCM in a local vault whose key is protected by Windows DPAPI, the macOS Keychain or your Linux keyring (or a machine-derived key, flagged as *Reduced protection*). It is never shown again after saving and never written to logs or the database. With WebKit it never reaches the browser process (a local relay adds the login); Chromium-family browsers and Firefox receive it to authenticate to the proxy directly. Anyone who can log in as your operating-system user can, in principle, use the app with it, so protect your OS account. See [Credential vault](/docs/security-and-privacy#credential-vault).

### Can I share the EXE or AppImage with colleagues?

Yes. The files contain no credentials and no personal data; everything is created on first run on each computer. Each person needs their own proxy plan and enters their own keys.

### Why does Windows show a SmartScreen warning?

The EXE is not Authenticode-signed unless a code-signing certificate is configured for the release. Click **More info**, then **Run anyway**. Update packages are still verified with the publisher's Ed25519 signature; see [Updates](/docs/updates#how-updates-are-verified).

## Platforms and updates

### Does it work the same on Windows, Linux and macOS?

The features are the same. The main differences:

| | Windows | Linux | macOS |
| --- | --- | --- | --- |
| Bundled engines | Downloaded on first run | Built into the AppImage | Downloaded on first run |
| Vault key protection | Windows DPAPI | GNOME Keyring / KWallet, or machine-derived | macOS Keychain |
| Vendor browser installs | winget (Opera GX available) | Official packages unpacked into the app folder, no root (no Opera GX) | Vendor download page |
| Updates | In the app, online or USB | In the app, online or USB | From the download page |
| WebKit | Native Windows build | Needs glibc 2.38 or newer | Native macOS build |

### Is there a Mac version?

Yes. Every release includes DMGs for Apple silicon and Intel Macs (macOS 12 or later) on the [download page](/#download). They are free but **unsigned** (not notarized by Apple, because the project has no Apple Developer account yet), so macOS asks you to allow each downloaded copy once: **System Settings → Privacy & Security → Open Anyway**. See [Install](/docs/install#macos). Updates on Mac come from the download page, so allow each new version the same way.

### How do I move to another computer?

Install the app there and run the first-run setup with your proxy keys; the vault cannot be decrypted on another machine. Copy the database to keep profiles and history. See [Move to another computer](/docs/install#move-to-another-computer).

### How do I uninstall it?

Delete the program and the data and key folders. See [Uninstall](/docs/install#uninstall).

## Contributing

### Can I add a feature or a proxy provider?

Yes, within the project scope. See [Contributing](/docs/contributing). Security issues are reported privately; see [Security](/security).
