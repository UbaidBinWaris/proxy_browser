# Proxy QA Browser

**New: desktop QA automation.** Record and save scenarios, import test datasets, group suites, select environments,
compare approved screenshots, and run browser/device/location matrices,
schedule local regression checks, export CI reports, configure custom proxy gateways,
and manage encrypted configuration backups under **QA automation**.
See [Desktop automation and distribution](docs/ENTERPRISE-DESKTOP.md) for usage,
verification commands, privacy limits, and publisher setup. This edition stays
desktop-only and requires no sign-in.

Proxy QA Browser is a desktop app (Windows and Linux) for **authorized QA
testing of your own web forms**. It opens a real browser window — bundled
Chromium, Firefox or WebKit, or a real Chrome, Edge, Brave, Opera, Opera GX,
Vivaldi or Chromium installed on the machine — inside an isolated browser
profile that emulates a chosen device (226 phone, tablet and desktop presets),
and routes it through a **DataImpulse** proxy exit IP in the US state, city or
ZIP code you pick (or connects directly). Before the window opens, the exit IP
is checked and compared with the location you asked for. Every launch is
recorded locally with its exit IP, location verdict, HTTP status, screenshot,
captured network requests and any lead / certificate IDs the form returned.

> **Responsible use.** Use this tool only on forms, funnels and sites that you
> own or are explicitly contracted to test, and only with a proxy plan you are
> entitled to use. It is not a tool for evading rate limits or fraud controls,
> scraping third parties, generating fake leads or impersonating real users.
> Respect DataImpulse's terms of service and the laws that apply to you.

## Contents

**For operators**

- [Download and run](#download-and-run)
- [First-run setup](#first-run-setup)
- [Using the app](#using-the-app)
- [Proxy and targeting (DataImpulse)](#proxy-and-targeting-dataimpulse)
- [Browsers](#browsers)
- [Devices](#devices)
- [Browser sessions](#browser-sessions)
- [Security and privacy](#security-and-privacy)
- [Settings reference](#settings-reference)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

**For developers**

- [For developers](#for-developers)
  - [Prerequisites](#prerequisites)
  - [Arch Linux notes](#arch-linux-notes)
  - [Quick start](#quick-start)
  - [npm scripts](#npm-scripts)
  - [Project structure](#project-structure)
  - [Architecture summary](#architecture-summary)
  - [Database schema and migrations](#database-schema-and-migrations)
  - [Testing](#testing)
  - [Building](#building)
  - [Releasing checklist](#releasing-checklist)
  - [Conventions](#conventions)
- [Acceptance checklist](#acceptance-checklist)
- [Credits and licences](#credits-and-licences)

---

# Part 1 — For operators

## Download and run

Choose the single portable Windows EXE or the Linux AppImage.
These builds contain no proxy credentials.

| Platform | File | Size (v1.2.0 build) | Browsers |
| --- | --- | --- | --- |
| Windows 10/11 x64 | `Proxy-QA-Browser-1.2.0-Windows-x64.exe` (portable) | 102,438,716 bytes (≈ 98 MiB) | Downloaded on first run |
| Linux x86-64 | `Proxy-QA-Browser-1.2.0-x86_64.AppImage` | 569,483,398 bytes (≈ 543 MiB) | Chromium, Firefox and WebKit built in |

### Windows (portable EXE)

1. Copy `Proxy-QA-Browser-1.2.0-Windows-x64.exe` anywhere (Desktop, Downloads,
   a USB stick). There is no installer and you do not need administrator rights.
2. Double-click it. The EXE is **not code-signed**, so Windows SmartScreen may
   show *"Windows protected your PC"*. Click **More info** → **Run anyway**.
   Some antivirus products are cautious with unsigned portable EXEs too; see
   [Troubleshooting](#troubleshooting).
3. The portable EXE **unpacks itself to `%TEMP%` on every launch**, so the
   window takes a few seconds to appear. Use **Set up on this computer** in
   **Settings → App & updates** for a stable local copy and faster later launches.
   Your data lives
   in `%APPDATA%\proxy-qa-browser` and the vault key in
   `%LOCALAPPDATA%\ProxyQABrowser\keys` (see [Data locations](#data-locations)),
   so moving or deleting the `.exe` loses nothing.
4. On first opening, setup starts automatically and downloads missing browser engines into
   `%APPDATA%\proxy-qa-browser\data\browsers` in the background (Chromium is
   required, Firefox and WebKit are optional). Together they take roughly
   400 MB; how long it takes depends on your connection. An internet connection
   is required for this first preparation. Progress, cancel and retry are available
   on the **Browsers** screen. Later openings reuse the downloaded engines.
   Microsoft Edge, which ships
   with Windows, is detected automatically and can be used as soon as setup is
   done. Proxy credentials can be skipped and added later from Settings.

For shortcut setup, Windows pinning, signed USB updates and the publisher’s
next-version workflow, see [Versioning and USB distribution](docs/DISTRIBUTION.md).

Only one copy of the app runs at a time: starting it again just brings the
open window to the front.

### Linux (AppImage)

1. Make the file executable and run it:

   ```bash
   chmod +x Proxy-QA-Browser-1.2.0-x86_64.AppImage
   ./Proxy-QA-Browser-1.2.0-x86_64.AppImage
   ```

2. AppImages mount themselves with **FUSE 2**. If you see
   `dlopen(): error loading libfuse.so.2`, install it — Arch: `sudo pacman -S
   fuse2`; Ubuntu 24.04: `sudo apt install libfuse2t64`; older Debian/Ubuntu:
   `sudo apt install libfuse2` — or run it with
   `./Proxy-QA-Browser-1.2.0-x86_64.AppImage --appimage-extract-and-run`.
3. The AppImage is **self-contained**: Chromium, Firefox and WebKit are inside,
   together with the Ubuntu libraries Playwright's WebKit needs on other
   distributions (ICU 74, flite 2.2, libxml2 2.9). Nothing is downloaded and
   no `pacman`/`apt` packages are needed for the browsers.
4. **glibc.** The app, Chromium and Firefox need glibc 2.25 or newer. The
   bundled **WebKit needs glibc 2.38 or newer** (it is built on Ubuntu 24.04),
   i.e. Ubuntu 24.04+, Debian 13+, Fedora 39+ or a current Arch. On older
   distributions Chromium and Firefox profiles work but WebKit does not start.

Your data lives in `~/.config/proxy-qa-browser` and the vault key in
`~/.local/share/proxy-qa-browser/keys`.

### Starting from an editor's terminal

Terminals hosted by an Electron app (VS Code, Cursor, …) often export
`ELECTRON_RUN_AS_NODE=1`. The app then behaves like plain Node.js and **no
window opens**. Start it without that variable:

```bash
env -u ELECTRON_RUN_AS_NODE ./Proxy-QA-Browser-1.2.0-x86_64.AppImage
```

Double-clicking the file in a file manager is not affected.

## First-run setup

On the very first start the app shows a four-step wizard instead of the normal
sidebar. On Windows, it opens directly at **Browsers** and starts missing downloads
automatically. Nothing in it contacts the proxy unless you press **Test connection**.

| Step | What you see | What you do |
| --- | --- | --- |
| 1. **Welcome** | What will happen, how the vault key is protected on this machine (**Key protection**, e.g. *Windows DPAPI (current user)*, *GNOME Keyring / libsecret*), and the **Vault file** / **Key file** paths with **Reveal vault folder** / **Reveal key folder** | **Get started** |
| 2. **Browsers** | Chromium (**Required**), Firefox and WebKit with their status. Entering this step queues every missing engine as a background download, one after another; each is verified with a headless test launch (no window) and shows **Verified ✓** with *Files found · Version … · Headless test launch* ticks | Wait for Chromium, then **Continue**; **Skip for now** appears when Chromium is there, no download is running and Firefox or WebKit is still missing. On a failure: **Retry install** |
| 3. **Proxy credentials** | **DataImpulse Residential** (**Required**) form: **Proxy host** (default `gw.dataimpulse.com`), **Port** (`823`), **Username**, **Password**, and *Advanced: sticky session template*. Below it, **Add DataImpulse Mobile credentials** (**Optional**) opens the same form for a Mobile plan | **Test connection** (one request through the proxy, nothing saved), then **Save encrypted**; then **Continue**. Without credentials: **Skip for now** |
| 4. **Done** (*"You're set"*) | Summary of browsers, proxy credentials and vault health, plus anything still pending | **Open launcher** |

- The **AppImage** ships its browsers, so its wizard has nothing to install:
  the Welcome step says *"Chromium, Firefox and WebKit ship inside this build"*
  and the Browsers step is skipped.
- The **Windows EXE** starts at Browsers whenever setup is unfinished and any
  engine is missing. Completed downloads are reused after closing or moving the EXE.
- The app never installs vendor browsers (Chrome, Opera, …) during setup; that
  is done later from Settings → Browsers.
- **Later starts.** Until you press **Open launcher**, every start reopens the
  wizard at the first step that still needs attention (on Windows, Browsers while
  any engine is missing; Proxy credentials while no pool has credentials), or at **Done**
  when nothing is pending. After that, the app always opens on **Launch**. Keys
  can be added or changed at any time with **Manage keys** (see
  [Manage keys window](#manage-keys-window)).

## Using the app

### Sidebar and status pill

The sidebar has five destinations, in this order: **Launch** (the start page),
**Sessions** (with a green count of open browsers), **History**, **Profiles**
and **Settings**. Below them is the **Tasks** button (a spinner and a count
while installs run, a check when all finished, a red dot and *Failed* after a
failure), and at the bottom the app version and one pill: **Proxy ready** when
at least one pool has keys, **Proxy not set** otherwise. Clicking the pill
opens Settings → Advanced → Proxy keys.

Toasts confirm what happened in the background, for example *"Browser open ·
<profile>"* with the exit IP, *"Launch failed · <profile>"* with the error
code, or *"Install Google Chrome — done"*.

### Launch

The start page is one form with one primary button. It remembers what you used
last.

**Header** — **Random all** picks a configured pool (Direct when none is
configured), a current device, a compatible installed browser and (unless the
pool is Direct) a random location, all at once.

**Connection** card

- **Proxy pool** — three one-line choices with a status dot: **Residential**,
  **Mobile** and **Direct** (no proxy, this machine's own IP). A pool without
  keys shows **Not set up** and cannot be selected; a **Manage keys** link
  under the row opens the [Manage keys window](#manage-keys-window). The
  shuffle icon (**Random pool**) picks one of the configured pools.
- **Exit location** — *Connect by* **Country**, **State**, **City** or **ZIP**
  (disabled for Direct):
  - **Country**: a two-letter code (`US` by default, from Settings).
  - **State / City / ZIP**: a search field over the bundled US location dataset
    (51 states incl. DC, 29,540 cities, 40,977 ZIP codes). With an empty query
    it lists **Recent** picks and **Popular states** / **Popular cities**
    (**All states** in State mode). Typing searches case- and
    accent-insensitively (`new j` → New Jersey; `newark nj` narrows a city or
    ZIP search to one state). City and ZIP searches have an **Any state**
    filter chip that limits results (and **Random**) to one state. Keyboard:
    ↑↓ move · Enter select · Esc close. The footer shows the number of matches.
  - **Random** picks a random state, city or ZIP of the current mode (inside
    the state filter when one is set). Random states only come from
    DataImpulse's published list of 50 states (DC is searchable but never
    picked at random).
- **Options · sticky / rotating** (collapsed) — **Sticky session** (on by
  default: *"Keeps the same exit IP for the whole session."*; off = a rotating
  exit IP) and **Session TTL (min)** (1–1440; *"Empty = provider default
  (~30)."*).

**Browser & device** card

- **Browser** — a picker grouped **Bundled** (Chromium, Firefox, WebKit) and
  **Installed** (Google Chrome, Microsoft Edge, Brave, Opera, Opera GX,
  Vivaldi, Chromium (system install)). Each row shows a status badge
  (**Bundled**, **Installed**, **Not installed**, **Installing…**,
  **Uninstalling…**) and the version. A missing browser has an inline
  **Install** (one click) or **Get** (opens the vendor's download page)
  button. Browsers that cannot emulate the chosen device are greyed out with
  the reason, e.g. *"Firefox can't emulate mobile devices"*; browsers with no
  build for your OS say *"Not available for this operating system"*. When the
  selected browser is not installed, a hint under the picker offers **Install
  <Browser>** / **Get <Browser>** and a **Browsers settings** link.
  **Random** picks an installed browser that supports the device.
- **Device** — the [device picker](#device-picker); **Random** picks a
  random current (non-legacy) device that an installed browser can emulate.
  Under it, one line names the user agent the device sends (e.g. *"Android
  Chrome user agent"*) with a **Copy user agent** button.

**Session** card

- **Start URL** — the page to open. *"Empty opens the default URL from
  Settings."* The field fills the Session card width. Click it or its arrow to
  show recent and saved URLs; type to search older addresses, then click an
  option or use Arrow Up/Down and Enter to fill the field. Escape closes the list.
  Only `http://` and `https://` URLs are accepted.
- **Frequent links** — one-click shortcuts ranked by usage in the latest 1,000
  stored launches. Saved profile links and the default URL are also available.
  Picking a shortcut fills Start URL; press Connect & Launch when ready.
- **Save as profile** — a compact checkbox in the Session header, off by default. Off, the launch creates a hidden
  *quick launch* profile; on, a name field appears and the profile is kept on
  the Profiles page. Left empty, the name is generated as *"<Pool> · <target> ·
  <device>"*, e.g. *"Residential · New Jersey · Apple iPhone 15"* (*"Direct ·
  <device>"* for Direct).
- **Will connect as** — the exact DataImpulse parameter string that will be
  sent, e.g. `cr.us;state.newjersey;sessid.ql-20261007-7f3a;sessttl.60`, with a
  copy button. It never contains your login or password. For Direct it reads
  *"Direct · this machine’s own connection"*; without a location and without
  sticky mode, *"No targeting parameters · any exit IP in the pool"*. An icon
  at the end carries warnings (state/city/ZIP targeting is billed at 2× by
  DataImpulse) and what the location policy will do (e.g. *"Re-rolls the
  session (up to 3 attempts) if the exit IP is outside New Jersey."*). A pool
  without keys is spelled out under the line.
- **Connect & Launch** — creates the profile, verifies the exit IP and opens
  the browser, and takes you straight to the [run page](#the-run-page). It is
  disabled while the pool has no keys, the browser is not installed, or the
  browser is being installed (*"Google Chrome is being installed — launch will
  be available when the install finishes."*).

**One session at a time.** By default only one browser can be open. If one is
already open, Connect & Launch shows **A session is already open** with **Go
to session**, **Close it and launch** and **Dismiss**. Turn this off under
Settings → General → **One session at a time** to run several browsers side by
side.

#### Device picker

The device field opens a large panel (a centered dialog on windows narrower
than 900 px):

- **Search** — *"Search brand, model, OS or size — pixel 9, ios 17, fold,
  1920"*, with the number of matching devices.
- **Filters** — device type **All / Phones / Tablets / Desktop** (with
  counts), orientation **Portrait** (default) / **Landscape** / **Both**,
  **Sort** (**Popular first**, **Newest**, **Name**, **Screen size**), **Brand**
  chips (desktops are listed as **Desktop PC**), **OS** chips, **Show legacy**
  (off by default) and **Compatible with <browser> only** (on by default).
  **Reset filters** appears when anything is narrowed.
- **Lists** — **Popular**, **Recent** (the last 8 devices you chose),
  **Favorites** and **All devices**.
- **Cards** — name, brand and release year (or OS for desktops), badges for
  OS, viewport, scale factor (`@3x`), **Touch**, **Landscape**, **Legacy** and
  **Unsupported** (with the reason), and a star to add or remove a favorite.
- **Keyboard** — arrow keys move through the grid, Home/End jump, Enter or
  Space selects, **F** stars the focused device, typing continues the search,
  ↑ from the first row returns to the search field, ↓ / Enter in the search
  field go to the grid / pick the first compatible device, Esc closes.
- **Footer** — **Random device** (among the listed devices), **Random
  popular**, and how many devices the filters hide.

Recent devices, favorites and recent locations are kept in this computer's app
storage only.

### The run page

Every launch opens its run at **History → run** (`/history/<id>`), titled
**Test result**, with the run status and a **quick launch** badge for unsaved
profiles.

**Live session card** (while the run's browser session exists)

- **Steps**: **Validating** → **Verifying proxy** (or **Checking exit IP** for
  Direct) → **Launching** → **Open**. On a failure only the step that was in
  progress is marked failed.
- A status line under the steps (e.g. *"Verifying proxy exit IP…"*, or during
  a location re-roll *"Exit IP 107.77.76.91 is in New York, NY 10118 —
  re-rolling session (2/3)…"*) and the current URL.
- **Pool**, **Requested** location and **Targeting string** (copyable).
- **Proxy verdict card**, shown before the browser window opens:
  - **PROXY READY** — the exit IP with **Public IP**, **Country**, **State /
    Region**, **City / ZIP**, **ISP** (and ASN), **Latency**, **Session** (the
    sticky id or *rotating*), *Checked … via <provider>*, and **Requested vs.
    verified**: a badge **Match** / **Partial** / **Mismatch** / **Unverified**
    with a sentence such as *"Requested New Jersey · Got New Jersey ✓"*. After a
    location re-roll: *"Sticky session re-rolled for location · exit IP from
    attempt 2 of 3"*, or the warning *"Could not get an exit IP in … after 3
    attempts; using …"*.
  - **DIRECT CONNECTION** — the machine's own exit IP (no proxy).
  - **PROXY FAILED** (or **EXIT IP CHECK FAILED** for Direct) — the error in
    plain words, its code (e.g. `PROXY_AUTH_FAILED`) and a **Retry launch**
    button.
- Errors after the proxy step (browser could not start, page timed out, HTTP
  error) appear as **Launch failed · <step>** with **Retry launch**.

**Header buttons** while the session is live: **Bring to Front** (focuses the
window; a minimised Chromium-based window is restored first), **Take Screenshot**, **Close Browser** (or
**Dismiss Session** for a launch that failed before any window opened). After
the session ends: **Delete Run** (asks for confirmation; the screenshot file
stays on disk). For a quick-launch profile: **Save as profile** keeps it on the
Profiles page.

**Result** tab

- **Test result** — Profile (with **Edit profile**), Browser, Device, Public
  IP, Pool, Requested, Connection (*DataImpulse · sticky / rotating* or *Direct
  (no proxy)*), Proxy session, Targeting string, Requested vs. verified,
  Country, State, City / ZIP, Location, Start time, Duration, HTTP status, Form
  URL and Final URL.
- **Outcome** — **Lead ID** and **Certificate ID** (*"Auto-filled when found in
  a JSON response."*; your own edits win), **Status** (**Success** /
  **Failed**), **Notes** (up to 4,000 characters). **Reset** and **Save
  Changes**; only fields you edited are saved.
- **Screenshot** — the last screenshot of the run with **Reveal in folder**.

**Network** tab — every request of the browser session (when the network
inspector is on): **Method**, **URL**, **Status**, **Request** / **Response**
time and **Duration**, with a text filter (*"Filter by URL, method or
status…"*) and quick filters `lead`, `submit`, `certificate`, `cert`, `form`,
`api`. IDs found in JSON responses (`leadId`, `lead_id`, `certificateId`,
`certificate_id`) are shown as badges; the first lead and certificate IDs found
are filled into the run's outcome.

### Sessions

*"Open browsers and their verified exit IPs."* Header buttons: **Refresh** and
**Launch**.

- **Live sessions** — one row per open (or failed, not yet dismissed) session:
  **Session**, **Pool**, **Requested**, **Verified** (with the match badge and
  "attempt N of M" after a re-roll), **Status**, **Started** and actions: open
  the run, **Bring to front**, take a screenshot, **Terminate session**. Select
  rows to **Terminate selected (N)**, or **Terminate all** (confirmation:
  *"Every open browser window (N) is closed and its run is marked aborted."*).
- **Recently finished** — the latest finished runs with Ended, Profile, Pool,
  Requested, Verified, Match and Status.

With no session open the page offers **Connect & Launch**.

### History

*"Every launch with its exit IP, outcome and captured ids."*

- **Overview** — **Profiles** (saved profiles), **Runs today**, **Success
  rate** (of finished runs) and **Last verified exit IP** (the most recent
  working proxy check).
- **Runs table** (latest 200) — Started, Profile, Engine, Device, Pool,
  Requested, IP, Location, Session, Status and Lead / Cert. Click a row to open
  the [run page](#the-run-page). **Refresh** reloads.

### Profiles

**Browser Profiles** are saved, repeatable setups. Quick launches stay hidden
here unless saved.

- **Profile card** — name, browser (a warning badge if it is not installed),
  device, proxy mode, pool, sticky session id, requested location, the last
  proxy status and exit IP; buttons **Launch Browser** and **Test Proxy** (one
  IP check through the profile's sticky session); the **…** menu has **Edit**,
  **Duplicate** (adds " (copy)" and a new sticky id) and **Delete**
  (confirmation; past runs are kept).
- **New Profile** / **Edit** opens the editor:
  - **Identity** — **Profile name**, **Device preset** (the same device
    picker), **Browser engine** (grouped Bundled / Installed; incompatible
    engines are disabled).
  - **Device emulation** — **Device type** (from the preset), **Viewport width
    (px)** and **height** (320–7680 × 320–4320), **User agent** (empty = the
    preset's), **Locale** (BCP 47, e.g. `en-US`), **Timezone** (IANA, e.g.
    `America/Chicago`; filled from the target state until you edit it).
  - **Proxy** — **Proxy mode** (**Direct (no proxy)**, **DataImpulse ·
    sticky**, **DataImpulse · rotating**), **Proxy pool**, **Sticky session
    ID** (required in sticky mode; letters, digits, `-` and `_`, max 64; it
    follows the name as `profile-<name>` until you edit it), **Target
    location** (Country / State / City / ZIP, clearable) and **Sticky TTL
    (minutes)** (1–1440).
  - **Form & notes** — **Form URL override** (empty = the default start URL),
    **Notes**; for a quick-launch profile, **Show this quick-launch profile on
    the Profiles page**.
  - **Cancel**, **Create Profile** / **Save Changes**, and **Delete** in the
    header.

### Settings

Settings has four tabs on the left: **General**, **Browsers**, **Advanced** and
**About**. Each setting lives in exactly one place. Changes on General and
Advanced are saved together from the **Save Changes** bar that appears while
something is unsaved (**Reset** discards); an invalid value opens its tab and
section and gets the focus. Every key is listed in the
[Settings reference](#settings-reference).

**General** — **Default start URL**, **One session at a time**, and the
**Screenshot folder** (read-only, with **Reveal**).

**Browsers**

- **Bundled browsers (Playwright)** — Chromium, Firefox and WebKit with their
  status and **Install** / **Reinstall** buttons and **Install All Missing**.
  In the AppImage this card shows **Bundled** and no install buttons.
- **Installed browsers** — the seven vendor browsers with **Status** (where
  the executable came from: *Detected automatically*, *Custom path*, *Path
  saved automatically*, or *Not installed* / *No build available*), version,
  **Path** (chips **auto** for a path the app saved, **custom** for one you
  set) and **Action**: **Install** (one click), **Get <Browser>** (vendor
  page) or **Uninstall** (only for copies the app installed). The header shows
  *"N of 7 available"*, **Install All Missing (N)** and **Re-detect**. Each
  row's **…** menu: **Set custom path** / **Change custom path** / **Clear
  custom path** (an inline editor with **Save** / **Cancel**). See
  [Browsers](#browsers).
- The footer shows where engines live (*"Downloaded engines live in …"* or
  *"Bundled engines live in … (read-only)"*) with **Reveal Folder**.

**Advanced** — collapsible sections; only **Proxy keys** is open by default,
and a link such as `#logs` opens its section:

| Section | Contents |
| --- | --- |
| **Proxy keys** | One row per pool (**Residential**, **Mobile**): **Configured** / **Not set up**, masked username, source (*Encrypted vault* or *Development .env*), *last tested …*, and **Test** (one request through that pool's gateway). **Manage keys…** opens the [Manage keys window](#manage-keys-window). **Security health** (*Healthy*, *Reduced protection*, *No vault yet* or *Attention needed*) with **Details**: Key protection, Key present, Vault present, Decrypts OK, Permissions OK, Install id, Key created, Vault updated, Last local check, Last proxy test, Warnings, **Reveal key folder**, **Reveal vault folder**, **Re-check** and **Rotate key** |
| **Targeting & location match** | **Default proxy pool**, **Default country**, **Place name encoding** (with a live example), **Location match** and **Attempts** |
| **Browser flags** | **Extra Chromium flags**, one per line |
| **IP verification** | **Provider**, **Timeout (ms)**, **Retries** |
| **Network inspector** | **Capture requests and extract lead / certificate ids**, **Navigation timeout (ms)** |
| **Proxy session history** | Every proxy session row (each profile's sticky session and the raw gateway row): Profile, Session ID, Status, IP, Location, ISP, Latency, Last checked, Error, with **Test** and **Rotate** (new sticky id, then a test) actions |
| **Logs** | The live log: level filter (**All levels**, INFO, WARN, ERROR), scope filter, search (*"Search messages and metadata…"*), **Auto-scroll**, **Clear Logs** |

**About** — version, **Packaged build** / **Development build**, platform,
Playwright version; **Locations** (User data, Data, Key, Vault, each with a
reveal button); **Attribution** (GeoNames, trademarks).

### Tasks panel

Every browser install or uninstall runs as a **background task**. The sidebar's
**Tasks** button opens **Background tasks** (*"Installs run one at a time and
are verified without opening a window."*): each task with its state —
**Queued (2nd)**, **Installing · 42%**, **Verifying…**, **Verified ✓**,
**Uninstalled**, **Failed** (with the reason) or **Cancelled** — a progress
bar, the elapsed time, **Cancel** (vendor installs ask *"Cancel “Install …”?"*
with **Cancel Install** / **Keep Installing**) and **Retry**. **Clear
Finished** removes finished entries. The last 20 finished tasks are kept
across restarts. Details: [Background tasks](#background-tasks).

### Manage keys window

Proxy logins are entered once and rarely change, so after setup they are
edited in a separate, temporary window, opened with **Manage keys…**
(Settings → Advanced → Proxy keys) or **Manage keys** on Launch:

- Title **Manage proxy keys**, header **Proxy keys** — *"Encrypted on this
  machine. Passwords are write-only and never shown again."*
- Tabs **Residential** and **Mobile**, each with its status (**Configured** /
  **Not set up**, **User** (masked, e.g. `ab****yz`), **Source**, **Last
  test**) and the credentials form (**Proxy host**, **Port**, **Username**,
  **Password**, *Advanced: sticky session template*) with **Test connection**
  and **Save encrypted**.
- For a pool already in the vault, **empty fields keep the stored value**
  (placeholders *"unchanged: ab****yz"* / *"unchanged"*), so a password can be
  changed without retyping the username. **Test connection** tests the merged
  result without saving anything.
- **Remove keys** (with confirmation) deletes a pool's encrypted entry.
- The window is modal on Windows and Linux, fixed in size, has no taskbar
  entry, blocks screenshots/screen recording on Windows (no effect on Linux),
  **closes itself after 5 minutes without input** (the footer counts down in
  the last minute) and is closed after 15 minutes regardless. **Close** closes
  it at once. Typed values live only in that window and are gone when it
  closes; only one such window can be open.

## Proxy and targeting (DataImpulse)

### Pools and logins

DataImpulse sells **Residential** and **Mobile** as separate plans, each with
its own login, on the same gateway (`gw.dataimpulse.com`, port `823` by
default). The app stores **one login per pool**. A pool without a login is
shown as **Not set up** and cannot be used; Residential logins are never used
for the Mobile pool. **Direct** uses no proxy at all.

Each user needs their **own DataImpulse plan**. Usage is billed by DataImpulse
to that plan; **state, city and ZIP targeting are billed at 2×** (the launcher
warns about it), country-only targeting at the normal rate. Every exit-IP check
and every location re-roll is one small HTTP request through the proxy.

### Username syntax

All provider-specific code is in `src/main/proxy/providers/dataimpulse.ts`.
Parameters are appended to the login after a double underscore: `__` starts
the list, `;` separates parameters, `.` separates key and value.

```
login__cr.us;state.newjersey;city.newark;zip.07102;sessid.ql-20261007-7f3a;sessttl.60
```

| Key | Meaning | Sent when |
| --- | --- | --- |
| `cr` | Country, lower-case ISO-2 | Always with a target (DataImpulse requires it with `state`/`city`/`zip`) |
| `state` | US state name, encoded | State, City and ZIP targets |
| `city` | City name, encoded | City and ZIP targets |
| `zip` | 5-digit ZIP code | ZIP targets |
| `sessid` | Sticky session id: keeps the same exit IP | Sticky sessions |
| `sessttl` | Sticky lifetime in minutes (1–1440) | Sticky sessions with a TTL |

- The order is always `cr`, `state`, `city`, `zip`, then any other parameters
  your saved login already carries, then `sessid`, `sessttl`.
- **A login that already contains parameters** (e.g. `mylogin__cr.us`) is
  parsed: its `cr`/`state`/`city`/`zip` are **replaced** by the launch's target
  (never duplicated), other parameters are kept, and its `sessid`/`sessttl` are
  replaced in sticky mode.
- **Encoding of place names** (Settings → Advanced → **Place name encoding**):
  accents and punctuation are removed and the text is lower-cased; `&` becomes
  `and`. Words are then joined according to the setting: **Remove spaces
  (DataImpulse default)** → `newjersey`, `stlouis`, `winstonsalem`; **Replace
  spaces with underscores** → `new_jersey`; **Keep spaces** → `new jersey`.
  DataImpulse's own state list (`resources/geonames/dataimpulse-states.csv`)
  uses the remove-spaces form.
- **Session template.** The `sessid` part is added through a template —
  default `{username}{sep}sessid.{session}`, where `{username}` is the login
  with its parameters, `{session}` the session id and `{sep}` is `;` when the
  login already contains `__`, otherwise `__`. A template can be saved with a
  pool's credentials (*Advanced: sticky session template*; it must contain
  `{username}` and `{session}`). `sessttl` is appended after the template.
- The **Will connect as** preview, the session and the run store only the
  parameter part (`cr.us;…`). The login and password are added inside the
  main process when the connection is built and never shown or stored in
  plain text.

### Sticky and rotating sessions

- **Sticky** (default): `sessid` pins one exit IP for about 30 minutes, or for
  **Session TTL** minutes. Quick launches generate a fresh id per launch,
  `ql-<YYYYMMDD>-<4 random characters>`. Saved profiles use their **Sticky
  session ID** (the editor suggests `profile-<name>`); a sticky profile without
  one gets `profile-<name>` (lower-case, dashes, at most 32 characters)
  generated and saved on first use.
- **Rotate** (Settings → Advanced → Proxy session history) appends `-r2`,
  `-r3`, … to the id — a new sticky session, normally with a new exit IP.
- **Rotating** (Sticky session off): no `sessid`/`sessttl` is sent; every
  request may use a different exit IP.

### Location verification

Before the browser opens, the app looks up the exit IP **through the same
proxy username the browser will use** and compares the reported country,
region, city and **postal code** with the target:

| Badge | Meaning |
| --- | --- |
| **Match** | Every requested level agrees: country; state; the city name for a City target; the **exact ZIP** (the IP's postal code) for a ZIP target |
| **Partial** | Right state, but another city (City target) or another / unreported postal code (ZIP target) |
| **Mismatch** | Another country, or another state |
| **Unverified** | No target, or the IP service did not report enough to compare |

#### Location match policy and re-rolls

A sticky session keeps one IP, so a bad draw would last the whole session. For
a **sticky session with a target**, the app therefore re-rolls the session id
(`-r2`, `-r3`, …) while the result falls short of **Location match**
(Settings → Advanced → Targeting & location match), up to **Attempts** IP
checks in total (first check included, 1–8, default 3):

| Location match | Re-rolls when the verdict is |
| --- | --- |
| **Off** | never — the first exit IP is used |
| **Same state (default)** | Mismatch (another state or country) |
| **Exact (city or ZIP)** | Mismatch or Partial — the city name or the exact ZIP must match |

- Each attempt is shown live on the run page and logged.
- **Rotating sessions are never re-rolled** (they cannot keep an IP), and with
  **Off** or **Attempts = 1** there is exactly one check.
- If the very first check fails, the launch fails. A later failed check only
  costs an attempt, except `PROXY_AUTH_FAILED` and `PROXY_DEAD` (the gateway
  refused a new sticky session), which stop re-rolling at once.
- If no attempt meets the policy, the launch continues with the **best**
  result (Match > Partial > Unverified > Mismatch; on a tie the later one). Its
  sticky id — which still holds that IP — is saved on the profile and used by
  the browser, and the run shows a warning such as *"Could not get an exit IP
  in ZIP 07102 (Newark, NJ) after 3 attempts; using Newark, NJ 07103 (same
  state)"*.

#### ZIP targeting caveat

Some ZIP codes have only a handful of exit IPs in the pool, and carrier
(mobile network) IPs often geolocate to the carrier's hub instead of the
subscriber's town. In a live test, `cr.us;zip.07102` (Newark, NJ) drew from two
IPs: one placed in Newark, NJ 07103 and a carrier IP placed in New York, NY
10118. Every sticky id that is tried keeps its IP pinned until it expires, so
re-rolling a thin ZIP can exhaust it: the gateway then answers **HTTP 503**
(`PROXY_DEAD`, *"The proxy gateway had no exit IP available for this session
and location right now"*) to new sticky ids for that ZIP until a session
expires (≈ 30 minutes or the TTL). ZIPs such as `90012` (Los Angeles) and
`60601` (Chicago) matched on the first draw. **Same state** is the pragmatic
default; for thin ZIPs use City or State targeting, rotating mode, or wait.

### IP-check services

The exit IP is looked up with one of three public services (Settings →
Advanced → IP verification → **Provider**). If the chosen one fails after its
retries, the app tries one other service once (the first of the remaining two
in the order ip-api, ipinfo, ipwhois). A `407` (bad
credentials) is never retried.

| Provider (label) | Endpoint | Postal code field |
| --- | --- | --- |
| `ip-api` — *ip-api.com (HTTP, free)* (default) | `http://ip-api.com/json/?fields=…` (plain HTTP on the free tier) | `zip` |
| `ipinfo` — *ipinfo.io* | `https://ipinfo.io/json` | `postal` |
| `ipwhois` — *ipwho.is* | `https://ipwho.is/` | `postal` |

Timeout: 15,000 ms by default (1,000–120,000); retries: 2 by default (0–5),
with exponential back-off starting at 500 ms. For **Direct** launches the same
services report this machine's own IP; if that lookup fails the launch
continues without an IP.

## Browsers

### Bundled and installed browsers

| Engine | Label in the app | Kind | Linux | Windows | Notes |
| --- | --- | --- | --- | --- | --- |
| `chromium` | Chromium (bundled) | Bundled | Inside the AppImage | Downloaded by the app (Playwright) | Chromium 153.0.8010.12 (Playwright build 1243). Required |
| `firefox` | Firefox (Playwright Firefox) | Bundled | Inside the AppImage | Downloaded by the app | Firefox 155.0 (build 1543). No phone/tablet emulation |
| `webkit` | WebKit / Safari-compatible QA | Bundled | Inside the AppImage (+ host libraries) | Downloaded by the app | WebKit 26.6 (build 2359). **Not Apple Safari** |
| `chrome` | Google Chrome (installed) | Installed | One click: official `.deb` unpacked into the app folder | One click: winget `Google.Chrome` (machine-wide; may show a UAC prompt) | |
| `msedge` | Microsoft Edge (installed) | Installed | One click: official `.deb` | Usually preinstalled; otherwise winget `Microsoft.Edge` | |
| `brave` | Brave (installed) | Installed | One click: official portable `.zip` (size and SHA-256 checked) | One click: winget `Brave.Brave` (per user) | |
| `opera` | Opera (installed) | Installed | One click: official `.deb` | One click: winget `Opera.Opera` (per user) | |
| `opera-gx` | Opera GX (installed) | Installed | **Not available** (no Linux build) | One click: winget `Opera.OperaGX` (per user) | |
| `vivaldi` | Vivaldi (installed) | Installed | One click: official `.deb` | One click: winget `Vivaldi.Vivaldi` (per user) | Installs, but **does not work under automation** (see below) |
| `system-chromium` | Chromium (system install) | Installed | Install with your package manager (`sudo pacman -S chromium`, `sudo apt install chromium`, …); detected automatically (**Get** opens chromium.org) | One click: winget `Hibbiki.Chromium` | Separate from the bundled Chromium |

- **Installed browsers are the real browsers**: they are started through
  Chromium's automation protocol with their own executable, so the window that
  opens really is Chrome, Edge, Brave, Opera or Vivaldi and identifies as
  itself. Each launch uses a fresh temporary browser profile; your own
  bookmarks, cookies and extensions are never touched.
- Without winget (App Installer) on Windows, every vendor browser falls back to
  **Get <Browser>**: the vendor's download page opens and the app checks every
  5 seconds, for up to 15 minutes, whether the browser has appeared; when it
  does, its path is saved and a toast says so. On Linux non-x86-64 systems the
  vendor packages are not available and the same fallback is used.
- **Install All Missing** queues every missing browser that has a one-click
  method; a failure does not stop the others.
- **Uninstall** removes a copy the app installed itself (Linux:
  `<userData>/data/installed-browsers/<engine>`) and forgets its saved path.
  Browsers installed any other way (including winget installs on Windows) are
  never touched — remove those with your system's tools.
- The app also contains code paths for macOS (Playwright's vendor installer for
  Chrome/Edge, vendor pages otherwise), but no macOS build is produced or
  tested.

### Linux one-click installs (no root)

The app downloads the vendor's **official** package and unpacks it into
`<userData>/data/installed-browsers/<engine>/` — no root, no package manager,
on any x86-64 distribution:

| Browser | Source | Executable inside |
| --- | --- | --- |
| Chrome | `https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb` | `opt/google/chrome/chrome` |
| Edge | newest `microsoft-edge-stable_*_amd64.deb` in `packages.microsoft.com/repos/edge/pool/…` | `opt/microsoft/msedge/msedge` |
| Vivaldi | newest `vivaldi-stable_*_amd64.deb` in `repo.vivaldi.com/archive/deb/pool/main/` | `opt/vivaldi/vivaldi-bin` |
| Opera | newest `opera-stable_*_amd64.deb` in `deb.opera.com/opera-stable/pool/…` | `usr/lib/x86_64-linux-gnu/opera-stable/opera` |
| Brave | latest GitHub release `brave-browser-<version>-linux-amd64.zip` | `brave` |

`.deb` files are read by a built-in `ar` reader; the payload is decompressed
in-process (gzip, zstd) or with the system `xz` / `bzip2` tools and unpacked
with the system `tar` (or a built-in reader). Unpacking happens in a
`<engine>.partial` folder that replaces the previous version only when
everything succeeded, so a failed update leaves the old version working. The
browsers still need the usual desktop libraries (NSS, GTK, …) that any desktop
distribution has.

### Windows one-click installs (winget)

`winget install --id <ID> -e --silent --accept-package-agreements
--accept-source-agreements --disable-interactivity`, plus `--scope user` for
Brave, Opera, Opera GX and Vivaldi (no administrator rights needed). "Already
installed" counts as success. To keep installers from opening browser windows:

- Opera and Opera GX get `--override "/silent /allusers=0 /launchopera=0
  /setdefaultbrowser=0 /desktopshortcut=0 /pintotaskbar=0"`; Vivaldi's winget
  manifest already passes `--do-not-launch-chrome`.
- After winget exits (and again after verification) the app closes any process
  running from the new browser's folder that **started after the install
  began** — never browser windows you already had open, never the app's own
  sessions.
- winget, PowerShell and the Playwright installer always run with hidden
  windows.

### How detection works

Detection never starts a browser to find it. For each installed browser the app
checks, in order:

1. the saved path (yours or the one the app saved), if the file exists;
2. the app's own install folder (`<userData>/data/installed-browsers/<engine>`);
3. well-known locations — e.g. `%PROGRAMFILES%\Google\Chrome\Application\chrome.exe`,
   `%LOCALAPPDATA%\Programs\Opera\opera.exe`, `/usr/bin/google-chrome-stable`,
   `/opt/brave.com/brave/brave`, `/usr/lib/x86_64-linux-gnu/opera-stable/opera`
   (full lists in `src/main/browser/engine-detect.ts`);
4. the `PATH` (with `PATHEXT` on Windows).

The **version** is read without running the browser on Windows: from the
`.exe`'s VERSIONINFO resource (`src/main/browser/pe-version.ts` parses the PE
headers), falling back to the version-named folder next to it
(`…\Application\154.0.8037.97\`). On Linux the app runs `<exe> --version`
(3-second limit), which prints and exits. (On macOS it would read
`Info.plist`.) Versions are cached per executable (path + size + modification
time) in `<userData>/data/engine-versions.json`, so an unchanged browser is
never probed twice. Detection results are cached for 60 seconds; **Re-detect**
scans again at once. A browser whose install task is running is only located
on disk until the task is over.

### Saved paths and moving to another machine

After every detection and every install, the executable's path is saved
automatically (chip **auto**). A path you set yourself (chip **custom**) wins
whenever the file exists and is never overwritten; a custom path that points
nowhere is reported as *"Custom path not found, ignored"*. An automatically
saved path whose file has disappeared is dropped on the next detection and
detection fills in what it finds instead — so settings copied to another
computer heal themselves. Do not point a custom path at a Snap or Flatpak
wrapper script; use the real browser binary.

### Background tasks

Every install and uninstall is a task on a serial queue: one runs at a time,
in order; asking for the same install while it is queued or running returns
the existing task. States: queued → running → verifying → done or failed;
any unfinished task can be cancelled.

After each install the app checks, in this order, without ever opening a
window:

1. the executable (or Playwright's `INSTALLATION_COMPLETE` marker) exists;
2. its version can be read (not by running it on Windows);
3. a **headless** test launch — start, new page, `about:blank`, close —
   succeeds within 30 seconds;
4. the executable path is saved.

Only then is the task **Verified ✓** (*"Verified · <version> · <path>"*);
otherwise it fails with *"Installed, but failed verification: <reason>"* and
**Retry**. **Cancel** stops the installer together with every process it
started (Windows: `taskkill /T /F`) and removes a half-downloaded Playwright
engine. Launching a browser whose task is queued or running is refused with
`ENGINE_BUSY`. The last 20 finished tasks are kept in
`<userData>/data/task-history.json`.

### Known limitation: Vivaldi

Vivaldi installs and is detected, but Vivaldi 8.2 hangs under automation when
the first page is created (reproduced outside the app with plain
playwright-core). Its install task therefore ends with *"Vivaldi installed but
does not support automation; choose another engine."*, and a Vivaldi launch
fails after the 45-second start-up limit with *"Vivaldi did not finish starting
within 45 s. This browser may not support automation; choose another engine."*
The hung browser is closed.

## Devices

The catalog (`src/main/browser/device-presets.ts`) is generated when the app
starts and currently holds **226 presets** (with playwright-core 1.63; the
number changes when Playwright adds devices):

| Type | Presets | Of which legacy | Examples |
| --- | --- | --- | --- |
| Desktop | 18 | 0 | Windows · Chrome · 1920×1080 (`windows-desktop`, plus HiDPI 2×), Windows 11 1366×768 / 1536×864 (125 %) / 2560×1440, Windows · Edge · 1920×1080, Linux · Chrome 1920×1080 / 1366×768, macOS · Chrome 1440×900 / 1512×982, Chromebook 1366×768, Playwright's *Desktop Chrome / Edge / Firefox / Safari* (and HiDPI) |
| Mobile | 184 | 58 | iPhone 6 … iPhone 17 Pro Max, 16e, 17e, Air and SE (3rd gen); Pixel 2 … Pixel 10 Pro XL; Galaxy S5 … S25 Ultra, A15 / A35 / A55, Z Fold 5–7 and Z Flip 6–7 (with cover screens); OnePlus 12 / Nord 4; Xiaomi 14, Redmi Note 13; Motorola Edge 50, Moto G Power (2024); Nexus, Lumia, BlackBerry Z30, Nokia N9 |
| Tablet | 24 | 8 | iPad (5th, 6th, 7th and 11th gen), iPad mini, iPad Pro 11", Galaxy Tab S4 / S9, Nexus 7 / 10, Kindle Fire HDX, BlackBerry PlayBook |

- **Composition**: 198 presets come from Playwright's own device descriptors
  (portrait **and** landscape variants; descriptors narrower than 320 px are
  skipped) and 28 are curated by this project (11 desktops and 17 Android phones
  Playwright lacks, with a Chrome user agent matching the bundled Chromium
  version). 116 are portrait and 110 landscape.
- **Metadata** shown in the picker: brand, model, OS and version (from the user
  agent), orientation, viewport, device scale factor, touch, screen-size class,
  release year (phones/tablets) and a **Popular** flag (23 current mainstream
  devices).
- **Legacy**: 66 discontinued devices (iPhone 6 … X/XR, first-gen SE, Pixel 2–4,
  Nexus, Lumia, BlackBerry, Galaxy S III/S5/Note II/Note 3, LG Optimus, Nokia
  N9, Kindle Fire HDX, Moto G4) carry a **Legacy** badge, are hidden unless
  **Show legacy** is on, and are never picked by Random.
- **Compatibility**: phone and tablet presets need mobile emulation, which
  Playwright Firefox does not support — they work on WebKit and every
  Chromium-family browser (bundled and installed), **never on Firefox**.
  Desktop presets work everywhere, except *macOS · Safari (WebKit)* (WebKit
  only), *Windows · Firefox* (Firefox only) and the Edge user-agent desktops
  (Chromium family only).
- **How emulation is applied**: each session gets its own browser context with
  the preset's viewport, device scale factor, touch and screen size, and
  `isMobile` for phones and tablets, plus the profile's locale and timezone.
  User agent rules: a user agent typed on the profile always wins; phone and
  tablet presets always send the device's user agent; **desktop presets force
  their Chrome user agent only on the bundled Chromium** (a generic test build
  with no identity of its own) — Firefox, WebKit and every installed browser
  keep their real user agent, so Brave reports as Brave and WebKit never claims
  to be Chrome. A custom viewport stops the preset's physical screen size from
  being reported.

## Browser sessions

- **Single-session mode** (Settings → General → **One session at a time**, on
  by default): only one browser session may be open (`SESSION_LIMIT`
  otherwise); **Close it and launch** closes the open one first. Independently
  of this setting, one profile can only have one open session.
- **Isolation**: every session is a separate Playwright browser process with
  its own context — separate cookies, storage, cache and proxy login.
- **Launch timeline**: the run and session are created at once and the page
  shows progress while, in the background, the exit IP is verified (and
  re-rolled if needed), the browser starts, and the start URL is opened (navigation
  timeout 60 s by default). Browser start-up, context and first page must finish
  within **45 seconds**, otherwise the launch fails with
  `BROWSER_LAUNCH_FAILED` and the browser is closed. An HTTP status of 400 or
  higher marks the run failed (`SITE_HTTP_ERROR`) but keeps the window open as
  evidence.
- **Heartbeat** (every 5 s): when the browser disconnects or you close its last
  tab/window, the session ends and the run is finalised; a crashed tab marks the
  session failed with *"The browser tab crashed"*.
- **Closing**: **Close Browser** / **Terminate** closes the window (and the
  WebKit relay). A run ends as **success** when the page loaded (HTTP < 400),
  **aborted** when it was cancelled during the launch, **failed** otherwise —
  you can change success/failed afterwards in **Outcome**.
- **Bring to front** restores a minimised Chromium-family window and focuses
  the page (Firefox and WebKit are focused without restoring).
- **Process tracking and crash clean-up**: every Chromium-family session
  browser is started with `--proxy-qa-session=<sessionId>` so its process can
  be found. Open sessions are recorded in `<userData>/data/live-sessions.json`.
  If the app crashed or was killed, the next start terminates exactly those
  browsers (by their marker; processes without it are never touched) and
  closes their runs as **aborted** — *"App was closed while this session was
  open"*. Firefox and WebKit sessions are tracked through Playwright's
  connection only, so after a crash their runs are closed but their windows
  cannot be found by marker. A normal quit closes every session (within about
  8 seconds) and cancels running installs.
- **Recorded per run**: profile, browser, device, pool, requested target,
  targeting string, exit IP, country, region, city, postal code, location
  verdict, attempts and warning, proxy session id, start URL, final URL, HTTP
  status, start/end time, status, screenshot path, lead ID, certificate ID,
  notes, error message, and the captured network requests.
- **Screenshots** are PNGs of the visible page named `<runId>-<timestamp>.png`
  in the screenshot folder.

## Security and privacy

### Credential vault

- Proxy logins are stored **encrypted, per machine and per OS user** in
  `<userData>/vault/proxy-credentials.vault` with **AES-256-GCM** (random
  12-byte IV, 16-byte tag; the header `{v, alg, installId}` is authenticated,
  so a vault cannot be moved to another installation). It holds one entry per
  pool. A vault from an older version (one login) is migrated automatically.
- The 256-bit vault key is never stored in clear. The key file
  `<installId>.key` holds it **wrapped** by one of two backends; the UI shows
  which:

  | Backend | Used when | Label |
  | --- | --- | --- |
  | OS keychain (Electron `safeStorage`) | Windows; Linux with a real keyring (GNOME Keyring / libsecret or KWallet) | *Windows DPAPI (current user)*, *GNOME Keyring / libsecret*, *KWallet* |
  | Machine-derived | No usable keychain (Linux `basic_text` or `unknown` backends are rejected because they offer no protection) | *machine-derived key (no OS keychain found — reduced protection)* |

  The machine-derived key is scrypt (N = 2¹⁵, r = 8, p = 1) over the machine
  id (`/etc/machine-id`, Windows `MachineGuid`, the host name as a fallback)
  and the OS user name, salted
  with the install id: anyone who can read the key file **and** knows those
  values can recover it. Install a keyring and use **Rotate key** to upgrade.
- The key directory is **outside** `<userData>` on purpose (copying the profile
  folder does not copy the key): `%LOCALAPPDATA%\ProxyQABrowser\keys` on
  Windows, `${XDG_DATA_HOME:-~/.local/share}/proxy-qa-browser/keys` on Linux.
  Key and vault files are owner-only (`0600`, directories `0700`) on Linux;
  Windows relies on the per-user profile permissions.
- Writes are atomic (temporary file + rename); a save reads the vault back and
  verifies it before reporting success. **Rotate key** writes the new key next
  to the old one, re-encrypts and verifies, then swaps; an interrupted rotation
  is recovered on the next start.
- **Security health** is checked locally, without network: key present and
  unwrappable, vault decrypts, permissions, backend. The app never tests the
  proxy at start-up (it would spend quota). An undecryptable vault (e.g. after
  copying it to another PC) shows *"Vault could not be decrypted with the
  current key — re-enter the proxy credentials"*; the app still starts.

### What is never logged or stored

- The password is write-only: it is never sent to the screen, never written
  to the database, logs or `install.json`, and never stored unencrypted. The
  renderer only ever receives host, port, a masked username (`ab****yz`) and
  where the credentials come from.
- Every password (and `user:password`) is registered with the log redactor the
  moment it is loaded, saved or tested. Every log line and every error that
  reaches the window passes through the redactor (`src/main/logging/redact.ts`):
  registered values become `[REDACTED]`, and credential shapes
  (`scheme://user:pass@host`, `Authorization` / `Proxy-Authorization` headers,
  `password=…`) are scrubbed even when the exact value is unknown.
- Targeting strings (`cr.us;state.newjersey;sessid.…`) are not secrets and are
  stored; logins are not.
- After start-up the proxy username/password environment variables are removed
  from the process environment, so browser processes and installers never
  inherit them.
- The network inspector stores method, URL, status, timing, resource type and
  extracted IDs. JSON response bodies (up to 512 KB) are inspected in memory for
  IDs and never stored.

### Electron hardening

- Every app window uses `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false` and `webSecurity: true`. The renderer only sees
  `window.api`, a fixed, typed set of functions exposed by the preload bridge
  (`src/preload/index.ts`); every call is validated with Zod in the main process
  and answers with `{ ok, data }` or `{ ok: false, error }`, never a thrown
  error.
- A strict Content Security Policy (`default-src 'self'`; images also from
  `data:`, `file:` and the app's own `proxyqa:` screenshot scheme) is applied to
  the app's pages. `window.open` is denied and navigation away from the app is
  blocked.
- Screenshots are shown through `proxyqa://screenshot/…`, which only serves
  files inside the screenshot folder. **Reveal** buttons only open paths inside
  the app's data folder or the screenshot folder (plus the fixed key and vault
  folders), and the only external pages the app can open are the seven vendor
  download pages.
- The [Manage keys window](#manage-keys-window) adds content protection,
  DevTools off in packaged builds, and an inactivity timeout.

### Local relay for WebKit

Playwright's WebKit cannot open HTTPS connections through a proxy that requires
a password. For WebKit sessions the app starts a small relay on
`127.0.0.1:<random port>` (loopback only) that adds the proxy login and
forwards to the gateway. WebKit is given only `http://127.0.0.1:<port>`; the
credentials never reach the browser process. Each session has its own relay,
closed with the session. Chromium and Firefox authenticate to the proxy
directly.

### Network connections

The app only talks to:

| Destination | When |
| --- | --- |
| The DataImpulse gateway (`gw.dataimpulse.com:823`) | Proxy tests, exit-IP checks and all traffic of proxied browser sessions |
| The selected IP-check service (ip-api.com, ipinfo.io or ipwho.is) | Every exit-IP check (through the proxy, or directly for Direct sessions); one fallback service on failure |
| The start URL / your form | Browser sessions |
| Playwright's browser download CDN | Downloading the bundled engines (Windows, development) |
| Vendor sites: `dl.google.com`, `packages.microsoft.com`, `repo.vivaldi.com`, `deb.opera.com`, `api.github.com` / `github.com` (Brave), winget sources | One-click browser installs |
| The vendor download page in your default browser | **Get <Browser>** |

Location search uses the bundled GeoNames data and never leaves the machine.
There is no telemetry and nothing is uploaded.

### Data locations

`<userData>` is `%APPDATA%\proxy-qa-browser` on Windows and
`${XDG_CONFIG_HOME:-~/.config}/proxy-qa-browser` on Linux. The exact paths are
listed under Settings → App & updates.

| What | Windows | Linux |
| --- | --- | --- |
| User data (`<userData>`) | `%APPDATA%\proxy-qa-browser\` | `~/.config/proxy-qa-browser/` |
| Vault key `<installId>.key` | `%LOCALAPPDATA%\ProxyQABrowser\keys\` | `~/.local/share/proxy-qa-browser/keys/` |
| Encrypted vault | `<userData>\vault\proxy-credentials.vault` | `<userData>/vault/proxy-credentials.vault` |
| Install id, setup state, last gateway test (no secrets) | `<userData>\install.json` | `<userData>/install.json` |
| Database (profiles, runs, proxy sessions, network capture, settings, logs) | `<userData>\data\proxy-qa.sqlite` | `<userData>/data/proxy-qa.sqlite` |
| Screenshots | `<userData>\data\screenshots\` | `<userData>/data/screenshots/` |
| Log files (`app-YYYY-MM-DD.log`, JSON lines, redacted) | `<userData>\data\logs\` | `<userData>/data/logs/` |
| Bundled engines (Chromium, Firefox, WebKit) | `<userData>\data\browsers\` (downloaded) | inside the AppImage (read-only) |
| Vendor browsers installed by the app | — (winget installs to the normal vendor location) | `<userData>/data/installed-browsers/<engine>/` |
| Open-sessions record | `<userData>\data\live-sessions.json` | `<userData>/data/live-sessions.json` |
| Browser version cache | `<userData>\data\engine-versions.json` | `<userData>/data/engine-versions.json` |
| Finished-task history | `<userData>\data\task-history.json` | `<userData>/data/task-history.json` |
| App's own UI storage (last Launch form, recent/favorite devices, recent locations) | Electron storage inside `<userData>` | same |
| Temporary unpacked program | `%TEMP%` (portable EXE, every launch) | AppImage mount (`/tmp/.mount_…`) |

The database keeps the latest 5,000 log rows. Deleting a profile deletes its
proxy session row; its runs are kept (shown without a profile link). Delete
runs on their run page (**Delete Run**). Screenshots stay on disk until you
delete them.

## Settings reference

All settings are stored in the database (`app_settings`) and validated with Zod
(`AppSettingsSchema` in `src/shared/types.ts`).

| Key | Where / label | Default | Meaning |
| --- | --- | --- | --- |
| `defaultFormUrl` | General → **Default start URL** | `https://example.com/` (or `PROXY_QA_DEFAULT_FORM_URL` while no value has been saved) | Opened when Launch has no Start URL and a profile has no Form URL override. `http(s)` only |
| `singleSessionMode` | General → **One session at a time** | on | Only one browser session may be open; Launch offers **Close it and launch** |
| `screenshotDir` | General → **Screenshot folder** (read-only) | `<userData>/data/screenshots` | Where screenshots are written |
| `browserExecutables` | Browsers → row **…** → **Set custom path** | `{}` | Executable path per installed browser (yours or saved automatically) |
| `browserExecutableOrigins` | Browsers (chips **custom** / **auto**) | `{}` | Who set each path: `user` (never overwritten while it exists) or `auto` (dropped when the file disappears) |
| `defaultProxyPool` | Advanced → Targeting → **Default proxy pool** | `residential` | Pool pre-selected on Launch; pool for raw gateway tests |
| `defaultTargetCountry` | Advanced → Targeting → **Default country** | `us` | Country pre-filled on Launch (`cr.<code>`) |
| `targetingEncoding` | Advanced → Targeting → **Place name encoding** | `remove-spaces` | How multi-word places are written: `remove-spaces`, `underscore`, `keep` |
| `locationMatchPolicy` | Advanced → Targeting → **Location match** | `state` (*Same state*) | `off`, `state` or `exact` — see [policy](#location-match-policy-and-re-rolls) |
| `locationMatchAttempts` | Advanced → Targeting → **Attempts** | `3` | Total IP checks for the policy (1–8) |
| `extraChromiumArgs` | Advanced → Browser flags → **Extra Chromium flags** | none | Extra command-line flags (`--flag` or `--flag=value`, one per line) for every Chromium-family launch, bundled and installed; Firefox and WebKit ignore them |
| `ipCheckProvider` | Advanced → IP verification → **Provider** | `ip-api` | `ip-api`, `ipinfo` or `ipwhois` |
| `ipCheckTimeoutMs` | Advanced → IP verification → **Timeout (ms)** | `15000` | 1,000–120,000 |
| `ipCheckRetries` | Advanced → IP verification → **Retries** | `2` | 0–5 retries on the selected provider |
| `networkInspectorEnabled` | Advanced → Network inspector → **Capture requests and extract lead / certificate ids** | on | Record requests and extract IDs |
| `navigationTimeoutMs` | Advanced → Network inspector → **Navigation timeout (ms)** | `60000` | 5,000–300,000; how long opening the start URL may take |

Proxy credentials are **not** settings: they live in the encrypted vault.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Windows: *"Windows protected your PC"* | The EXE is not code-signed | **More info** → **Run anyway**. See [FAQ](#faq) for code signing |
| Windows: antivirus quarantines or slows the EXE | Unsigned portable EXEs that unpack themselves to `%TEMP%` look suspicious to some scanners | Restore it / add an exception for the file, or sign the build |
| Windows: the window takes several seconds to appear | The portable EXE unpacks itself to `%TEMP%` on every launch | Use **App & updates → Set up on this computer**, then launch the local shortcut |
| **Browsers opened by themselves on Windows** (fixed in this version) | Older versions read browser versions by running `chrome.exe --version` (and Edge, Brave, Opera, Vivaldi), which on Windows opens a window; Opera/Brave installers also started the browser after installing | Update. Versions are now read from the `.exe` file without running it, Opera installs pass `/launchopera=0`, and windows an installer opens after an install are closed. Windows you opened yourself are never touched |
| Linux: `dlopen(): error loading libfuse.so.2` | FUSE 2 missing | Install `fuse2` / `libfuse2t64` / `libfuse2`, or run with `--appimage-extract-and-run` |
| Linux: AppImage fails with a `chrome-sandbox` / namespace error | Unprivileged user namespaces disabled | Enable them (e.g. `sudo sysctl kernel.unprivileged_userns_clone=1` where that sysctl exists, or your distribution's AppArmor/userns setting) |
| Linux: WebKit does not start from the AppImage, Chromium/Firefox do | glibc older than 2.38 | Use a newer distribution (Ubuntu 24.04+, Debian 13+, Fedora 39+) or other engines |
| No window opens, Node-style output in the terminal | `ELECTRON_RUN_AS_NODE` is set (editor terminals) | `env -u ELECTRON_RUN_AS_NODE …` |
| `PROXY_AUTH_FAILED` / HTTP 407 | Wrong username or password, plan inactive, or the plan does not allow the requested option | Re-enter the keys in **Manage keys**, **Test connection** first, then **Save encrypted**. Check the plan in your DataImpulse account |
| `PROXY_DEAD` with *"…no exit IP available… (HTTP 503)"* | The gateway has no free exit IP for this new sticky session and location (typical for thin ZIPs) | Launch again later (≈30 min), use rotating mode, or target the city/state — see [ZIP caveat](#zip-targeting-caveat) |
| `PROXY_DEAD` / `PROXY_TIMEOUT` (other) | Gateway unreachable, port 823 blocked, exit node offline | **Test** the pool under Settings → Advanced → Proxy keys; check firewall/VPN; rotate the session; raise the IP-check timeout |
| `DNS_FAILURE` | Gateway host or start URL does not resolve | Check the proxy host in **Manage keys**, the start URL and your DNS |
| `IP_VERIFY_FAILED` | The IP-check service failed or answered strangely | Pick another **Provider** under Advanced → IP verification, raise timeout/retries |
| `PROXY_NOT_CONFIGURED` / pool shows **Not set up** | No login saved for that pool (Mobile needs its own Mobile-plan login) | **Manage keys** → the pool's tab → enter and save |
| Location badge **Mismatch** / **Partial** | Exit IP geolocates elsewhere (carrier IPs, thin pools) | Use **Same state** or **Exact** with more **Attempts**, or a broader target. The run's warning says what was used |
| Targeted launches rejected or more expensive than expected | State/city/ZIP targeting needs `cr` and is billed 2×; unusual spellings are refused | Keep **Remove spaces (DataImpulse default)**; confirm your plan allows geo targeting |
| `BROWSER_MISSING` (Chromium/Firefox/WebKit) | Engine not downloaded yet (Windows) | Settings → Browsers → **Install**. The AppImage never needs this |
| `BROWSER_MISSING` (Chrome, Edge, Brave, Opera, …) | Browser not found | Settings → Browsers → **Install** / **Get <Browser>**, **Re-detect**, or **Set custom path** to the real binary |
| Browser install fails on Linux: *"Unpacking this package needs the "xz" tool…"* | `xz` is missing | Install `xz` (`xz-utils` on Debian/Ubuntu) and **Retry** |
| Install fails on Windows with a winget error | Outdated winget sources, declined UAC prompt (Chrome), or no App Installer | `winget source update`, retry and accept the prompt; or use **Get <Browser>** |
| Task fails with *"Installed, but failed verification: …"* | The browser installed but the headless test launch failed (or files were not found) | Read the reason in **Tasks** and **Retry**. For Vivaldi this is expected |
| Vivaldi launches fail after 45 s | Vivaldi does not support automation | Use another browser |
| `ENGINE_BUSY` | That browser is being installed or uninstalled | Wait for the task (sidebar **Tasks**) or cancel it |
| `SESSION_LIMIT` / *"A session is already open"* | One session at a time is on | **Close it and launch**, terminate on Sessions, or turn the setting off |
| `SITE_TIMEOUT` | The start URL did not load in time | Raise **Navigation timeout (ms)**; check proxy latency |
| `SITE_HTTP_ERROR` | The page answered with HTTP 400 or higher | Check the URL; the window stays open for inspection |
| `SSL_ERROR` | Invalid TLS certificate | Check the domain; try Direct to isolate the proxy |
| *"Vault could not be decrypted with the current key"* | Key file replaced, vault copied from another PC, keyring changed, or `install.json` recreated | Re-enter and save the credentials |
| Security health shows *Reduced protection* | No usable OS keychain (Linux without GNOME Keyring/KWallet) | Install and unlock a keyring, restart, then **Rotate key** |
| A session stays open after closing its window | Older versions kept a windowless browser running | Update: closing the last tab ends the session within about 5 s |
| Developer: `npm run build:linux` fails with `EACCES` in `~/.cache/electron-builder` | An earlier Docker build left the cache root-owned | `sudo chown -R "$USER:$USER" ~/.cache/electron ~/.cache/electron-builder release`, or build with `ELECTRON_BUILDER_CACHE=$HOME/.cache/electron-builder-local` |
| Developer: WebKit fails in `npm run dev` on Arch (`libicuuc.so.74`, `libflite*.so.1`, `libxml2.so.2` not found) | Playwright's WebKit is built for Ubuntu | See [Arch Linux notes](#arch-linux-notes) |
| Developer: `Cannot find module 'node:sqlite'` | Host Node older than 22.13 | Upgrade Node |

### Error codes

| Code | Meaning |
| --- | --- |
| `PROXY_NOT_CONFIGURED` | No credentials for the selected pool |
| `VAULT_ERROR` | Vault key or vault file missing, corrupt or not decryptable |
| `PROXY_AUTH_FAILED` | The proxy rejected the credentials (HTTP 407) |
| `PROXY_TIMEOUT` | The proxy did not answer in time |
| `PROXY_DEAD` | Could not connect through the gateway, or it refused the session (HTTP 502/503/504) |
| `DNS_FAILURE` | A host name could not be resolved |
| `IP_VERIFY_FAILED` | The IP-check service failed or returned an unexpected answer |
| `BROWSER_MISSING` | The selected browser is not installed |
| `BROWSER_LAUNCH_FAILED` | The browser could not start (or not within 45 s) |
| `SITE_TIMEOUT` | The start URL did not load within the navigation timeout |
| `SITE_HTTP_ERROR` | The start URL answered with HTTP ≥ 400 |
| `SSL_ERROR` | TLS certificate problem |
| `INVALID_PROFILE` | The profile cannot be launched as configured (or already has an open session) |
| `INVALID_INPUT` | A value failed validation |
| `NOT_FOUND` | The record does not exist |
| `SESSION_CLOSED` | The browser session is already closed |
| `SESSION_LIMIT` | Another session is open while single-session mode is on |
| `ENGINE_BUSY` | The browser is being installed or uninstalled |
| `INTERNAL` | Anything else; details are in Settings → Advanced → Logs |

## FAQ

**Can I share the EXE / AppImage with colleagues?**
Yes. The files contain no credentials and no personal data: everything is
created on first run on each machine. Each person needs **their own DataImpulse
plan and login**, entered in their own first-run setup. The builds are
**unsigned**, so Windows shows SmartScreen and some antivirus tools may
complain. To avoid that, sign the EXE with a Windows code-signing certificate
(OV or EV from a certificate authority, or a cloud signing service such as
Azure Trusted Signing); electron-builder can sign during `npm run
build:windows` when signing is configured — no signing is configured in this
repository today.

**Does it work the same on Windows and Linux?**
The features are the same. The differences:

| | Windows (portable EXE) | Linux (AppImage) |
| --- | --- | --- |
| Bundled engines | Downloaded on first run into `%APPDATA%` | Built into the AppImage |
| Vault key protection | Windows DPAPI | GNOME Keyring / KWallet, or machine-derived without a keyring |
| Vendor browser installs | winget (Opera GX available) | Official packages unpacked into the app folder, no root (no Opera GX; system Chromium via the package manager) |
| Uninstall from the app | Not for winget installs | For browsers the app installed |
| Version detection | Read from the `.exe` resources | `<browser> --version` |
| Post-install window clean-up | Yes | Not needed |
| Manage keys window | Blocks screen capture | Screen capture not blocked |
| Start-up | Unpacks to `%TEMP%` each launch | Mounted, no unpacking |
| WebKit | Native Windows build | Ubuntu libraries bundled; needs glibc ≥ 2.38 |

**Is my password safe?**
It is encrypted with AES-256-GCM in a local vault whose key is protected by
Windows DPAPI or your Linux keyring (or a machine-derived key, flagged as
*Reduced protection*). It is never shown again after saving, never written to
logs or the database, and never given to the browser. Anyone who can log in as
your OS user on that machine can, in principle, use the app with it — protect
your OS account. See [Security and privacy](#security-and-privacy).

**How do I move to another PC?**
Install the app there and run the first-run setup, including your proxy
credentials — the vault cannot be decrypted on another machine (the key is
tied to the machine and OS user and is deliberately not stored next to the
vault). To keep profiles and run history, close the app on both machines and
copy `<userData>/data/proxy-qa.sqlite` (and the `screenshots` folder if you
want them) into the new `<userData>/data/`. Saved browser paths heal
themselves on the next start. If you copy the whole `<userData>` folder instead,
expect the *"Vault could not be decrypted"* warning and re-enter the keys.

**How do I reset or uninstall?**
Close the app, then delete:

| | Windows | Linux |
| --- | --- | --- |
| Program | the `.exe` | the `.AppImage` |
| Data, vault, database, downloaded engines, app-installed browsers | `%APPDATA%\proxy-qa-browser` | `~/.config/proxy-qa-browser` |
| Vault key | `%LOCALAPPDATA%\ProxyQABrowser` | `~/.local/share/proxy-qa-browser` |

Browsers installed with winget stay installed; remove them in Windows
**Settings → Apps** if you no longer want them. Deleting only the vault key or
`install.json` makes the stored credentials unreadable (you will have to
re-enter them); deleting `<userData>` starts the first-run setup again.

---

# Part 2 — For developers

## For developers

### Prerequisites

| What | Version | Notes |
| --- | --- | --- |
| Node.js | **≥ 22.13** (`package.json` → `engines`) | Tests and tooling use `node:sqlite`. CI uses Node 24. The packaged app uses Electron's own Node (24.21.0 in Electron 44.5.1) |
| npm | 10+ | Lockfile v3; `npm ci` |
| Docker (optional) | any recent | Cross-building the Windows EXE from Linux (`electronuserland/builder:wine`); alternatively a local `wine` |
| `ar`, `tar` with zstd | — | Only for `--webkit-libs` (`npm run build:linux`) |
| A Windows machine (optional) | Windows 10/11 | Native Windows builds and the Windows smoke test |

Main versions: Electron 44.5.1, playwright-core 1.63.0, React 19.3, Vite 7.3,
electron-vite 5, Tailwind CSS 3.4, Zustand 5, Zod 4.6, TypeScript 6.0,
Vitest 5, ESLint 10. No native Node modules are compiled (`node:sqlite` is
built in).

### Arch Linux notes

```bash
sudo pacman -S nodejs npm fuse2           # Node >= 22.13; fuse2 to run AppImages
sudo pacman -S docker                      # only for the Windows cross-build
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"            # log out and back in afterwards
```

**Browser runtime libraries (development only).** The packaged AppImage needs
none of this. `npx playwright install-deps` targets `apt` and does not work on
Arch; install the pacman equivalents:

```bash
sudo pacman -S --needed nss atk at-spi2-core libdrm libxkbcommon mesa alsa-lib \
  gtk3 libxcomposite libxdamage libxrandr pango cairo woff2 libepoxy \
  gstreamer gst-plugins-base gst-plugins-good libwebp enchant libsecret \
  hyphen flite libxss libxtst libcups dbus harfbuzz-icu libjpeg-turbo \
  libmanette libavif lcms2
```

Find anything still missing with `ldd` (`pacman -F <lib>` names the package):

```bash
BROWSERS=~/.cache/ms-playwright
ldd "$BROWSERS"/chromium-*/chrome-linux*/chrome        | grep 'not found'
ldd "$BROWSERS"/firefox-*/firefox/firefox              | grep 'not found'
ldd "$BROWSERS"/webkit-*/minibrowser-gtk/MiniBrowser   | grep 'not found'
```

**WebKit host libraries for `npm run dev`.** Playwright's WebKit is built on
Ubuntu 24.04 and on Arch lacks `libicu{uc,i18n,data}.so.74`, the
`libflite*.so.1` voices and the legacy `libxml2.so.2`. The AppImage carries
them; in development the app does not add them, so reuse the build's bundle:

```bash
node scripts/bundle-browsers.mjs --platform linux --webkit-libs   # once; ≈ 24 MB of .debs → 63 MB of libraries
LD_LIBRARY_PATH="$PWD/build/webkit-libs/linux${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 env -u ELECTRON_RUN_AS_NODE npm run dev
```

(The first command also downloads ≈ 1 GB of Linux browsers into
`build/browsers/linux/`; both folders are git-ignored and cached.) Check
WebKit on its own with:

```bash
LD_LIBRARY_PATH="$PWD/build/webkit-libs/linux" PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 \
  node -e 'require("playwright-core").webkit.launch({headless:true}).then(async b=>{console.log("webkit OK",b.version());await b.close()})'
```

Alternatively install `flite` and `libxml2-legacy` with pacman and provide
ICU 74 system-wide (e.g. the Ubuntu `libicu74` `.deb` from
`scripts/bundle-browsers.mjs` extracted to `/opt` and registered in
`/etc/ld.so.conf.d`).

**Host quirks.** Shells inside VS Code/Cursor export `ELECTRON_RUN_AS_NODE`;
prefix Electron commands with `env -u ELECTRON_RUN_AS_NODE`. A
`~/.cache/electron-builder` left root-owned by an earlier Docker run breaks
local builds: `sudo chown -R "$USER:$USER" ~/.cache/electron
~/.cache/electron-builder release`, or set
`ELECTRON_BUILDER_CACHE=$HOME/.cache/electron-builder-local`.

### Quick start

```bash
npm ci
npm run browsers:install        # Chromium, Firefox and WebKit into ~/.cache/ms-playwright (dev cache)
cp .env.example .env            # optional, development only: DATAIMPULSE_* credentials
env -u ELECTRON_RUN_AS_NODE npm run dev
```

- **`.env` (development only).** Packaged builds never read a `.env` file or the
  `DATAIMPULSE_PROXY_*` variables. In development the first existing file wins
  — `<electron executable dir>/.env`, then `<project>/.env`, then
  `<userData>/.env` — and variables already in the environment are not
  overridden. `.env` credentials map to the **Residential** pool with source
  *Development .env*; anything saved in the vault takes precedence.

  | Variable | Purpose |
  | --- | --- |
  | `DATAIMPULSE_PROXY_HOST`, `DATAIMPULSE_PROXY_PORT`, `DATAIMPULSE_PROXY_USERNAME`, `DATAIMPULSE_PROXY_PASSWORD` | Development Residential login |
  | `DATAIMPULSE_SESSION_TEMPLATE` | Default sticky-session template (read from the process environment in every build; a template saved with credentials wins) |
  | `PLAYWRIGHT_BROWSERS_PATH` | Override the browsers directory (any build) |
  | `PROXY_QA_DEFAULT_FORM_URL` | Default start URL while none has been saved in Settings (any build) |

- Development and packaged builds on the same machine share
  `~/.config/proxy-qa-browser` (the app name is `proxy-qa-browser` in both).
  Use a separate profile with `--user-data-dir=<dir>` when that matters.
- Browsers in development come from Playwright's cache
  (`~/.cache/ms-playwright`, `%LOCALAPPDATA%\ms-playwright`) unless
  `PLAYWRIGHT_BROWSERS_PATH` is set.

### npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | `electron-vite dev`: main, preload and renderer with hot reload (DevTools open detached) |
| `npm run build` | `electron-vite build` → `out/main`, `out/preload`, `out/renderer` |
| `npm run preview` | `electron-vite preview`: run the built `out/` without packaging |
| `npm test` | `vitest run` (891 tests) |
| `npm run test:watch` | `vitest` in watch mode |
| `npm run typecheck` | `tsc` for `tsconfig.node.json` (main, preload, shared, renderer `lib`/`stores`, tests) and `tsconfig.web.json` (renderer) |
| `npm run lint` | ESLint (typescript-eslint; `no-explicit-any`, `consistent-type-imports`) |
| `npm run browsers:install` | `scripts/install-browsers.mjs [chromium\|firefox\|webkit …]`: install engines into the dev cache (honours `PLAYWRIGHT_BROWSERS_PATH`) |
| `npm run build:linux` | `scripts/bundle-browsers.mjs --platform linux --webkit-libs` → `npm run build` → `electron-builder --linux --x64` → self-contained AppImage |
| `npm run build:windows` | `npm run build` → `electron-builder --win --x64` → slim portable EXE (on Windows, or on Linux with wine) |
| `npm run build:windows:bundled` | `scripts/build-windows-bundled.mjs`: bundle the win64 engines, build, package with `PROXY_QA_BUNDLE_BROWSERS=1` |
| `npm run release:version -- patch` | Increase the version in the package and lockfile together |
| `npm run release:init` | Initialize or validate the stable publisher key pair |
| `npm run release:usb` | Sign current Windows and Linux files and create the USB manifest/checksums |
| `npm run build:all` | `scripts/build-all.mjs`: on Linux the AppImage, then the EXE via local wine or Docker; on Windows the EXE |

Other scripts: `scripts/build-all.sh` (Bash version of `build:all`, always uses
Docker for Windows), `node scripts/bundle-browsers.mjs --platform linux|win64
[--webkit-libs] [--force]`, `node scripts/make-icons.mjs` (icons) and
`node scripts/windows-smoke.cjs` (Windows smoke test).

### Project structure

```
.
├── .github/workflows/windows-smoke.yml  Windows build + smoke test (GitHub Actions)
├── build/
│   ├── icons/                 icon.svg, icon-small.svg (sources) → icon.png 512, 256.png, icon.ico
│   ├── browsers/<platform>/   bundled Playwright engines (generated, git-ignored)
│   └── webkit-libs/           Ubuntu WebKit host libraries + .deb cache (generated, git-ignored)
├── docs/ARCHITECTURE.md       module map, bootstrap order, launch data flow
├── public/old_app/            screenshots of the previous tool (reference only; not built)
├── resources/geonames/        US.txt (GeoNames), dataimpulse-states.csv, attribution (shipped)
├── scripts/                   build, bundle, icon, browser-install and smoke-test scripts
├── src/
│   ├── shared/
│   │   ├── types.ts           domain types + Zod schemas, settings, error codes (main + renderer)
│   │   └── ipc.ts             IPC channels, push events, the window.api contract
│   ├── preload/index.ts       contextBridge: exposes exactly window.api
│   ├── main/
│   │   ├── index.ts           entry: picks the browsers dir before playwright-core loads
│   │   ├── main.ts            composition root, bootstrap, windows, CSP, shutdown
│   │   ├── contracts.ts       main-process module interfaces + AppException
│   │   ├── config/            paths (userData layout, key dir) and dev .env loading
│   │   ├── security/          vault, AES-GCM crypto, key wrapping, machine id, install.json, partial updates
│   │   ├── database/          node:sqlite, migrations (schema.ts), one repository per table
│   │   ├── logging/           logger (DB + daily files) and secret redaction
│   │   ├── proxy/             DataImpulse provider, proxy manager, IP checker, WebKit relay
│   │   ├── locations/         GeoNames loader, location search, state → time zone
│   │   ├── launcher/          Quick Launch (preview + launch from the Launch page)
│   │   ├── browser/           browser manager, provisioner, detection, versions, presets, installers/
│   │   ├── tasks/             background task queue, install executor, headless smoke launch
│   │   ├── sessions/          live-sessions.json and crash clean-up
│   │   ├── system/            process discovery/termination (CIM, /proc, ps)
│   │   ├── windows/           Manage keys window, app icon
│   │   ├── ipc/               handlers per domain, validation wrapper, events, screenshot protocol
│   │   └── util/              atomic file writes, timeouts
│   └── renderer/
│       ├── index.html         CSP source tags
│       └── src/
│           ├── pages/         Launch, Sessions, History, RunDetail, Profiles, ProfileEditor, Settings, Setup, KeysWindow
│           ├── components/    feature components, ui/ primitives, layout/, settings/, tasks/, icons/
│           ├── lib/           pure, unit-tested UI logic (forms, pickers, targeting, navigation, CSP)
│           ├── stores/        Zustand stores (one per domain)
│           ├── hooks/         small React hooks
│           └── styles/        Tailwind globals
├── tests/                     Vitest suites (+ helpers/, fixtures/)
├── electron-builder.config.mjs  packaging (AppImage + portable EXE, extra resources)
├── electron.vite.config.ts    main/preload/renderer bundling
└── .env.example               development-only credentials template
```

### Architecture summary

- **Process model.** The Electron **main process** owns all state and all
  secrets: Playwright (`playwright-core`) runs there and drives the browsers;
  SQLite, the vault, the proxy provider and every installer live there. The
  **renderer** (React 19 + Zustand + Tailwind) talks to it only through
  `window.api` (`ProxyQaApi` in `src/shared/ipc.ts`): 61 invoke channels, each
  validated with Zod and answered with `IpcResult<T>`, plus 8 push events
  (`event:session-update`, `event:run-update`, `event:log-entry`,
  `event:network-entry`, `event:proxy-session-update`, `event:tasks-update`,
  `event:browser-watch`, `event:security-update`). The Manage keys window is the
  same renderer at `#/keys`.
- **Bootstrap order.** `src/main/index.ts` resolves the browsers directory
  (env → bundled → provisioned → dev cache) and exports
  `PLAYWRIGHT_BROWSERS_PATH` (and `PROXY_QA_WEBKIT_LIBS` for the AppImage)
  **before** importing `main.ts`, because playwright-core reads the variable
  once. `main.ts` then: registers the `proxyqa:` scheme and the single-instance
  lock → paths → `.env` (development only) → database → logger → process
  toolkit, provisioner, IP checker, provider, locations, proxy/profile/browser
  managers, launcher, task manager → crash clean-up of orphaned sessions →
  `ready` → vault (Electron `safeStorage` needs `ready`) → screenshot protocol,
  CSP, IPC handlers → main window. Any failure shows a native error box.
- **Launch is non-blocking**: `launcher.quickLaunch` / `browser.launch` return
  the new session at once; verification, browser start and navigation report
  through events.

Full module map, data flows and the relay design:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Database schema and migrations

SQLite via Node's built-in `node:sqlite` (WAL, foreign keys), file
`<userData>/data/proxy-qa.sqlite`. Tables: `profiles`, `proxy_sessions`,
`test_runs`, `network_entries`, `app_settings`, `logs`, and
`schema_migrations`. Migrations live in `src/main/database/schema.ts`; each runs
once in its own transaction and is recorded. Never edit a published migration —
add a new one.

| Version | Name | Change |
| --- | --- | --- |
| 1 | `initial-schema` | All tables and indexes |
| 2 | `proxy-sessions-cascade-and-country-code` | `proxy_sessions` rebuilt with `ON DELETE CASCADE` and `country_code` (runs keep `SET NULL`) |
| 3 | `proxy-pools-and-geo-targeting` | `profiles.proxy_pool`, `target_json`, `sticky_ttl_minutes`, `ephemeral`; `proxy_sessions` and `test_runs`: `pool`, `target_json`, `targeting_string`, `target_match` |
| 4 | `postal-code-and-location-attempts` | `proxy_sessions.postal_code`; `test_runs.postal_code`, `location_attempts`, `location_max_attempts`, `location_warning` |

No column ever holds a login or password.

### Testing

```bash
npm test                    # 869 tests including real Chromium recording and visual comparisons
npx vitest run tests/dataimpulse.test.ts
npm run typecheck && npm run lint
```

- Unit tests cover the shared schemas, the DataImpulse username builder, IP
  checker parsing, vault crypto and lifecycle, migrations, IPC validation,
  preload bridge, detection, PE version reader, installers (with in-memory
  archives), task manager, orphan clean-up, process parsing, device catalog,
  location search and the renderer's pure logic (`src/renderer/src/lib`,
  `stores`). `tests/context-isolation.test.ts` launches a real Chromium and is
  skipped when none is installed; a few tests are Linux- or POSIX-only.
- **Live end-to-end checks** drive the real app (built or packaged) with
  playwright-core's `_electron.launch`, call `window.api.*` directly and take
  screenshots. Run them with a throw-away `--user-data-dir`, unset
  `ELECTRON_RUN_AS_NODE`, and keep credentials out of logs. Note that
  `_electron.launch` passes `--password-store=basic`, so on Linux the vault falls
  back to the machine-derived key during such runs — a property of the harness.
- **Windows smoke test** — `scripts/windows-smoke.cjs` drives
  `release/win-unpacked/Proxy-QA-Browser.exe` the same way and checks: Windows
  DPAPI key backend and `%LOCALAPPDATA%` key path, no credentials baked in,
  **no `msedge.exe`/`chrome.exe` started by three re-detects and the Browsers
  tab**, Edge detected with a version read from the `.exe` resources, a
  verified first-run Chromium download task, `ENGINE_BUSY` while Firefox
  installs, location search, direct launches of bundled Chromium (Pixel 9) and
  installed Edge, bring-to-front, no renderer console errors, no
  `--proxy-qa-session` process left after quitting, and persistence across a
  restart. No proxy credentials are needed. Results and screenshots go to
  `smoke-output/`.

  ```powershell
  npm ci
  npm run build:windows
  node scripts/windows-smoke.cjs
  ```

  **GitHub Actions** — `.github/workflows/windows-smoke.yml` ("Windows build +
  smoke test") runs on `windows-latest` with Node 24: `npm ci`, typecheck, unit
  tests (reported but non-blocking), `npm run build:windows`, the smoke test,
  and uploads the EXE plus `smoke-output/` as the `windows-build-and-smoke`
  artifact. It runs on every push to `main` and manually via **Actions →
  Windows build + smoke test → Run workflow** (or `gh workflow run
  windows-smoke.yml`). The workflow file must be committed and pushed first.

### Building

Artifact names come from `electron-builder.config.mjs` and the `version` in
`package.json`:

```
release/Proxy-QA-Browser-<version>-x86_64.AppImage        Linux, self-contained
release/Proxy-QA-Browser-<version>-Windows-x64.exe        Windows portable (the only Windows artifact)
```

Current 1.2.0 builds: AppImage 569,483,398 bytes (≈ 543 MiB), EXE
102,438,716 bytes (≈ 98 MiB).

**Linux AppImage (native)**

```bash
npm run build:linux
# 1. node scripts/bundle-browsers.mjs --platform linux --webkit-libs   (cached in build/)
# 2. npm run build
# 3. electron-builder --linux --x64 --config electron-builder.config.mjs
```

The bundle step needs network the first time: Playwright's Linux engines at
the revisions pinned by playwright-core (`chromium-1243`, `firefox-1543`,
`webkit-2359`, `ffmpeg-1011`; ≈ 1 GB unpacked — the headless shell is deleted
because the app only needs full browsers) and the Ubuntu `.debs` for WebKit
(`libicu74`, `libflite1` 2.2, `libxml2` 2.9.14 from `archive.ubuntu.com`; the
17 required sonames are verified and `THIRD-PARTY-NOTICES.txt` is written).
They ship as `resources/playwright-browsers` and `resources/webkit-libs`. An
engine with an `INSTALLATION_COMPLETE` marker is skipped next time, so later
builds work offline; `--force` re-downloads. A missing bundle produces a slim
AppImage with a warning instead of a failed build.

At runtime a bundle counts only if all three engines are complete; the
bootstrap then sets `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` and
`PROXY_QA_WEBKIT_LIBS`, and the browser manager prepends that directory to
`LD_LIBRARY_PATH` for **WebKit processes only**. The UI reports the browsers as
*bundled* and read-only.

**Windows portable EXE**

```powershell
npm ci
npm run build:windows            # slim: engines downloaded on first run
npm run build:windows:bundled    # optional: engines inside the EXE
```

The portable target re-extracts its whole payload to `%TEMP%` on every launch,
so the default build stays slim and downloads the engines once into
`%APPDATA%\proxy-qa-browser\data\browsers`. `build:windows:bundled` runs
`bundle-browsers --platform win64` (works from Linux through
`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=win64`) and packages with
`PROXY_QA_BUNDLE_BROWSERS=1`; expect a 30–90 s start-up per launch.

**Both from Linux**

```bash
npm run build:all       # AppImage, then the EXE with local wine or Docker
scripts/build-all.sh    # same, always via Docker
```

Both check Node ≥ 22.13 and that `~/.cache/electron`, `~/.cache/electron-builder`
and `release/` are writable (creating the caches before any `docker run`). The
Windows half runs in `electronuserland/builder:wine` **as your uid/gid** with a
tmpfs `HOME`, the container's `node_modules` in the named volume
`proxy-qa-win-node-modules`, and `npm ci --ignore-scripts`. They print `BUILD
COMPLETE` and the artifact paths only when every expected artifact exists,
otherwise list what is missing and exit 1. Without wine and Docker,
`build:all` prints how to install either.

**Packaging details**: `asar` with `playwright-core` unpacked (it spawns
browsers and its installer runs as a child process through Electron with
`ELECTRON_RUN_AS_NODE=1`); `npmRebuild: false`; `resources/geonames` ships on
both platforms; `build/icons/icon.png` is the Linux icon (and the window icon),
`build/icons/icon.ico` the Windows icon; `publish: null` (nothing is uploaded).

**Icons** — edit `build/icons/icon.svg` (and `icon-small.svg`, used up to
32 px), then run `node scripts/make-icons.mjs` (needs the dev Chromium from
`npm run browsers:install`). It renders each size from the vectors with a
transparent background and writes `build/icons/icon.png` (512),
`build/icons/256.png`, `build/icons/icon.ico` (16, 24, 32, 48, 64, 128, 256)
and `src/renderer/src/assets/app-icon.png` (64).

### Releasing checklist

1. Bump the version: `npm run release:version -- patch` (updates
   `package.json` and `package-lock.json`; artifact names follow it).
2. `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`.
3. Build: `npm run build:all` on Linux (or `npm run build:linux` there and
   `npm run build:windows` on Windows).
4. Smoke-test the AppImage on a clean Linux user (`--user-data-dir` and a fresh
   `XDG_DATA_HOME`): first-run setup, save + test credentials, launch
   Chromium, Firefox and WebKit through a pool.
5. Smoke-test the EXE on Windows: `node scripts/windows-smoke.cjs` on a real PC
   or the GitHub Actions workflow, plus one proxied launch by hand.
6. Sign the EXE if a certificate is available.
7. Add release notes to `resources/release-notes.json`, run `npm run release:usb`,
   then distribute the current executable, signed JSON and checksums as described
   in [Versioning and USB distribution](docs/DISTRIBUTION.md). Update the
   [Acceptance checklist](#acceptance-checklist) statuses.

### Conventions

- TypeScript `strict` (plus `noUncheckedIndexedAccess`, `noImplicitOverride`)
  everywhere; no `any` (lint error); `import type` for types.
- All external data is validated with **Zod** (IPC arguments, settings, vault
  files, `install.json`, IP-service responses, histories). Shared types and
  schemas live only in `src/shared/`; the renderer never imports `src/main`.
- Errors cross IPC as `AppError { code, message, detail? }` with actionable
  messages; no stack traces or secrets.
- **No secrets in logs**: register every credential with
  `logger.registerSecret()` as soon as it is known; never log a
  `ProxyConnection`, a full username with password, or `Proxy-Authorization`.
- **Never commit `.env`** or anything with real credentials (`.env` and
  `.env.*` are git-ignored, only `.env.example` is tracked). Generated folders
  (`out/`, `release/`, `build/browsers/`, `build/webkit-libs/`, `data/`,
  `smoke-output/`) are git-ignored too.
- UI labels name exactly what runs: WebKit is "WebKit / Safari-compatible QA",
  never Safari; installed browsers are named as themselves.
- Pure logic goes into testable modules (`src/main/**` helpers,
  `src/renderer/src/lib`) with injected filesystem, process and time where
  needed.

## Acceptance checklist

"Verified" means checked on the Arch Linux development machine (dev build
and/or the AppImage), against the live DataImpulse gateway where a proxy is
involved. Windows items can only be confirmed on a real Windows PC or the
GitHub Actions smoke test; as of this README that run is **still pending**.

**Original MVP (1–17)**

| # | Test | Expected | Status / how verified |
| --- | --- | --- | --- |
| 1 | App starts clean | Empty `<userData>`: setup wizard, then Launch; `data/` with `proxy-qa.sqlite`, `screenshots/`, `browsers/`, `logs/` | Verified (dev + AppImage) |
| 2 | Credential setup | Test credentials → working exit IP, nothing persisted; Save → vault, source *Encrypted vault*, no restart; password nowhere in logs | Verified (live, through `window.api`) |
| 3 | Browser status + install | Each engine installed/missing with path and Playwright version; install streams progress and is verified; AppImage reports *bundled*, `installable: false`, install refused | Verified (Linux dev/provisioned and AppImage); Windows download path covered by the smoke test — pending Windows run |
| 4 | Profile CRUD | Inline validation; Duplicate adds "(copy)" and a new sticky id; Delete asks, removes the proxy session row, keeps runs | Verified |
| 5 | Proxy test, sticky, rotate | Gateway test shows IP, location, ISP, latency; sticky profile keeps its IP; Rotate gives `-r2` and a new IP | Verified (live) |
| 6 | Proxy auth failure | Wrong password → `PROXY_AUTH_FAILED`, active credentials untouched, password not logged | Verified (live) |
| 7 | Direct launch | Profile with proxy mode *Direct*: run page at once, **DIRECT CONNECTION** card with this machine's IP, form opens | Verified |
| 8 | Chromium through DataImpulse | **PROXY READY** before the window; IP matches; form loads | Verified (live) |
| 9 | Firefox through DataImpulse | Same with Firefox | Verified (live) |
| 10 | WebKit through DataImpulse | HTTPS form loads through the local relay; iPhone viewport; AppImage uses bundled host libraries on Arch | Verified (live; `ldd` + launch from the AppImage) |
| 11 | Concurrent sessions + isolation | With single-session off, two windows, no shared cookies/storage | Verified (manual + `tests/context-isolation.test.ts`) |
| 12 | Screenshot, network inspector, persistence | PNG saved and shown; requests listed and filterable; lead/certificate IDs extracted; data survives restart | Verified |
| 13 | AppImage builds (self-contained) | `npm run build:linux` → AppImage with 3 engines (no headless shell) and the 17 WebKit sonames | Verified (v1.2.0 build, 569 MB) |
| 14 | AppImage runs | `fuse2`; packaged; browsers *bundled*; only *credentials* pending; `.env` files and `DATAIMPULSE_PROXY_*` variables ignored; key backend *GNOME Keyring / libsecret*; all three engines launch with nothing downloaded | Verified (fresh `--user-data-dir` + `XDG_DATA_HOME`) |
| 15 | Windows portable EXE builds from Linux | `scripts/build-all.sh` → `BUILD COMPLETE`, AppImage + portable EXE, no installer | Verified (cross-built on the Linux host; current v1.2.0 EXE, 102 MB) |
| 16 | Windows portable EXE runs | Starts after unpacking; wizard asks for browsers and credentials; DPAPI key in `%LOCALAPPDATA%\ProxyQABrowser\keys`; engines in `%APPDATA%\proxy-qa-browser\data\browsers`; tests 1–12 pass | **Pending Windows run** (`scripts/windows-smoke.cjs` / GitHub Actions + manual proxied launch) |
| 17 | Secret hygiene | Password and `user:pass@` absent from logs, log files, database, `install.json`, key file; vault is ciphertext; relay logs show only `host:port` | Verified |

**Later additions**

| # | Test | Expected | Status / how verified |
| --- | --- | --- | --- |
| 18 | Vault lifecycle | Save → launch → finish setup → restart (`firstRun: false`, decrypts) → **Rotate key** (credentials kept, no `.rotating` left) → remove keys (source none, key kept) | Verified (60/60 checks via `window.api`; keyring backend confirmed in direct launches) |
| 19 | Launch by state | `new j` → New Jersey → `cr.us;state.newjersey;sessid.ql-…`; **PROXY READY** with a New Jersey IP and **Match** | Verified live: the `state.newjersey` encoding was confirmed against the gateway; full UI walk-through to re-confirm |
| 20 | Launch by city and ZIP | City adds `city.newark`; ZIP adds `zip.07102`; ZIP **Match** only when the IP's postal code equals it; postal code shown | Verified live for ZIP verification (e.g. 90012, 60601 match; 07102 see #21) |
| 21 | Location re-roll | **Exact**, 3–4 attempts: re-rolls shown live; ends on a match or the best result with the warning; browser uses the chosen sticky id; **Off** = one check | Verified live (07102 behaviour depends on the provider pool at the time; HTTP 503 when exhausted) |
| 22 | Pools | Mobile without a Mobile login is **Not set up** / `PROXY_NOT_CONFIGURED`; with one, a carrier exit IP; Residential login never used for Mobile | **Not verifiable yet — needs a DataImpulse Mobile plan login**; Residential verified |
| 23 | Random | Random pool/location/device/browser and **Random all**: only configured pools, compatible presets, never legacy, no phone on Firefox | Unit-tested (`device-presets`, `renderer-launcher` tests); UI check pending |
| 24 | Single-session + terminate | Second launch → **A session is already open**; **Close it and launch** replaces; **Terminate selected / all** finalise runs | Pending UI walk-through (logic unit-tested) |
| 25 | Save as profile / quick launch | Without the checkbox the profile is hidden; with it (or **Save as profile** on the run page) it appears on Profiles | Pending UI walk-through |
| 26 | One-click vendor installs (Linux) | Chrome, Edge, Brave, Opera install without root, verified, path auto-saved, launch works; Uninstall removes them | Install + launch verified live on Arch for Chrome, Edge, Brave and Opera (Vivaldi installs but fails verification — expected); install → uninstall cycle unit-tested |
| 27 | Background tasks | Serial queue, progress, **Verified ✓** after a headless launch, Cancel kills the installer tree, Retry, history survives restart, `ENGINE_BUSY` while installing | Verified on Arch; Windows part in the smoke test — pending Windows run |
| 28 | No browser windows on Windows | Re-detect and Settings → Browsers start no `chrome.exe`/`msedge.exe`; versions read from `.exe` resources; installers' windows closed | **Pending Windows run** (`scripts/windows-smoke.cjs`) |
| 29 | Session maintenance | Closing the last tab ends the session within ~5 s; crashed tab reported; **Bring to Front** restores a minimised window; after killing the app, the next start terminates marked browsers and marks runs aborted | Verified on Arch (live, incl. the orphan clean-up path); Windows part pending |
| 30 | Manage keys window | Opens once, modal, partial update keeps stored values, Test does not save, Remove keys asks, closes after 5 min idle | Verified on Arch (unit tests + live); screen-capture blocking only applies on Windows — pending Windows run |

## Credits and licences

- **Proxy QA Browser** — © 2026 Ubaid Bin Waris. Private project; the
  `package.json` licence is `UNLICENSED`.
- **Location data** — postal code data © [GeoNames](https://www.geonames.org),
  licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
  (`resources/geonames/US.txt`; see
  [resources/geonames/ATTRIBUTION.md](resources/geonames/ATTRIBUTION.md) and
  [README-geonames.txt](resources/geonames/README-geonames.txt)).
  `dataimpulse-states.csv` lists the state values published by DataImpulse.
- **Electron** (MIT) and **Chromium** (BSD-style and others, see
  `LICENSES.chromium.html` next to the app binary).
- **Playwright / playwright-core** (Apache-2.0) and the browser builds it
  downloads — Chromium, Firefox (MPL 2.0) and WebKit (LGPL/BSD) — under their
  own licences.
- **WebKit host libraries in the AppImage** — unmodified binaries from the
  Ubuntu packages `libicu74` (Unicode/ICU licence), `libflite1` (BSD-style,
  Carnegie Mellon University) and `libxml2` (MIT). The AppImage includes
  `resources/webkit-libs/THIRD-PARTY-NOTICES.txt` with each package's URL,
  version, upstream and licence.
- **Icons** — brand marks from [react-icons](https://react-icons.github.io/react-icons/)
  (MIT): Simple Icons (CC0 1.0) and Font Awesome 6 (CC BY 4.0); UI icons from
  Lucide (ISC). Browser and device logos are trademarks of their respective
  owners and are used only to identify them.
- Also used: React, React Router, Zustand, Zod, Tailwind CSS, dotenv, Vite,
  electron-vite, electron-builder, Vitest, TypeScript, ESLint — each under its
  own licence.
- DataImpulse, Google Chrome, Microsoft Edge, Brave, Opera, Vivaldi, Firefox,
  Safari, Windows and other names are trademarks of their owners. This project
  is not affiliated with any of them.
