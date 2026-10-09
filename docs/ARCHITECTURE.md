# Architecture

Proxy QA Browser is an Electron desktop app. The **main process** owns every
piece of state and every secret; the **renderer** is a React dashboard that
talks to it exclusively through a typed, promise-based IPC bridge. Playwright
runs inside the main process and drives real Chromium, Firefox and WebKit
builds — plus real browsers already installed on the machine (Chrome, Edge,
Brave, Opera, Opera GX, Vivaldi, system Chromium) through the Chromium
`BrowserType` with their own executable — one isolated `BrowserContext` per
QA profile. The default **Launch** page builds a one-shot ("ephemeral")
profile from a proxy pool, a US location (state / city / ZIP from the bundled
GeoNames dataset), a device preset and an engine, shows the exact DataImpulse
targeting string it will send, and launches it through the same pipeline as a
saved profile.

```
┌──────────────────────────── Electron main ────────────────────────────┐
│  index.ts           bootstrap entry: resolves + exports                │
│                     PLAYWRIGHT_BROWSERS_PATH (and the bundled WebKit   │
│                     libs dir), then imports main.ts ("Bootstrap order")│
│  main.ts            boot: resolve paths → .env (dev only) → open DB → │
│                     construct modules → ready → credential vault →    │
│                     register IPC → open window                        │
│                                                                        │
│  config/   env.ts     .env lookup (development) + env validation      │
│            paths.ts   <userData>/data + vault layout; key dir outside │
│                       userData (AppPaths)                             │
│  security/ crypto.ts            AES-256-GCM blobs, scrypt machine key │
│            key-wrapper.ts       safeStorage / machine-derived wrapping│
│            credential-vault.ts  CredentialVault (encrypted store)     │
│            install-state.ts     install.json (installId, setup state) │
│            machine-identity.ts  machine-id / MachineGuid / IOPlatform │
│            credentials-merge.ts partial key update ⊕ stored entry     │
│  logging/  logger.ts  Logger (SQLite-backed, pushes to renderer)      │
│            redact.ts  secret redaction (registered values + patterns) │
│  database/ index.ts   Database (node:sqlite DatabaseSync)             │
│            schema.ts  versioned migrations (v1 schema, v2 cascade,    │
│                       v3 pools + geo targeting, v4 postal code +      │
│                       location attempts)                              │
│            repositories/*  one repository per table                   │
│  proxy/    providers/dialect.ts      ProviderDialect + capabilities   │
│                                      (pure provider syntax)           │
│            providers/gateway-provider.ts  GatewayProvider: the        │
│                                      ProxyProvider for any dialect    │
│            providers/registry.ts     ProviderRegistry (id → gateway)  │
│            providers/dataimpulse.ts  DataImpulse dialect (per-pool    │
│                                      logins, cr/state/city/zip/       │
│                                      sessid/sessttl)                  │
│            targeting-text.ts         neutral place-name encoding,     │
│                                      not-configured messages          │
│            proxy-manager.ts          ProxyManager (pool resolution,   │
│                                      requested-vs-verified match)     │
│            ip-checker.ts             IpChecker (ip-api/ipinfo/ipwhois)│
│            local-relay.ts            per-session authenticating relay │
│                                      on 127.0.0.1 (WebKit + auth)     │
│  geo data  resources/geonames/       GeoNames US postal dataset       │
│                                      (41k ZIPs, 29.5k cities, 51      │
│                                      states) + DataImpulse state list;│
│                                      loaded once, searched in main    │
│  browser/  browsers-path.ts          browsers dir precedence (env →   │
│                                      bundled → provisioned → dev      │
│                                      cache) + WebKit libs env; no     │
│                                      playwright-core import           │
│            engine-detect.ts          installed-browser detection      │
│                                      (well-known paths + PATH scan,   │
│                                      60 s cache); no playwright-core  │
│            version-probe.ts          versions WITHOUT running the     │
│                                      browser on Windows/macOS (PE     │
│                                      resource / Info.plist; Linux:    │
│                                      --version) + engine-versions.json│
│                                      cache keyed by path+size+mtime   │
│            pe-version.ts             pure-JS PE VERSIONINFO reader +  │
│                                      version-folder fallback          │
│            executable-paths.ts       auto-saved / user executable     │
│                                      paths + origins (prune, never    │
│                                      overwrite user paths)            │
│            install-support.ts        install method per OS + vendor   │
│                                      download-page allow-list         │
│            installers/               one-click installs:              │
│              linux-user-space.ts     .deb / .zip → <userData>/data/   │
│                                      installed-browsers/<engine>      │
│              linux-sources.ts        vendor URLs, apt-pool listings,  │
│                                      Brave GitHub release             │
│              ar-archive.ts           pure-JS ar (.deb) reader         │
│              tar-archive.ts          gz/zst/xz decompress + tar       │
│              zip-archive.ts          pure-JS ZIP reader (modes, CRC)  │
│              download.ts             streamed download, size/SHA-256  │
│              winget.ts               Windows winget command/progress, │
│                                      --override for Opera / Opera GX  │
│              post-install-sweep.ts   Windows: close windows a vendor  │
│                                      installer opened after the       │
│                                      install began                    │
│              install-watcher.ts      "Get <Browser>" detection poll   │
│              system-tools.ts         PATH lookup, spawn helpers       │
│            browser-manager.ts        BrowserManager (Playwright; 45 s │
│                                      launch+context+page deadline;    │
│                                      --proxy-qa-session marker, pid,  │
│                                      5 s heartbeat, crash, focus)     │
│            browser-provisioner.ts    BrowserProvisioner (installs +   │
│                                      engine availability)             │
│            profile-manager.ts        ProfileManager (saved + ephemeral│
│                                      quick-launch profiles)           │
│            device-presets.ts         226 presets generated from       │
│                                      Playwright descriptors + curated │
│                                      customs; listPresets/randomPreset│
│            network-inspector.ts      request/response capture         │
│            error-mapping.ts          Playwright errors → AppErrorCode │
│  launcher/ launcher.ts               Quick Launch: preview string +   │
│                                      ephemeral profile + launch       │
│  locations/ locations-service.ts     state / city / ZIP search, random│
│                                      picks, state → time zone         │
│  tasks/    task-manager.ts           serial background queue for      │
│                                      installs/uninstalls (dedupe,     │
│                                      cancel = kill process tree,      │
│                                      history, events)                 │
│            install-executor.ts       install → [sweep] → verify       │
│                                      (exists, version, headless smoke,│
│                                      path saved) → Verified / failed  │
│            smoke-launch.ts           headless launch → about:blank    │
│  sessions/ live-sessions-store.ts    live-sessions.json (open sessions│
│                                      + browser pids)                  │
│            orphan-cleanup.ts         start-up: kill marked browsers of│
│                                      a crashed run, runs → aborted    │
│  system/   processes.ts              CIM via hidden PowerShell, /proc,│
│                                      ps; marker lookup; kill trees    │
│  windows/  keys-window.ts            "Manage proxy keys" window       │
│                                      options + single-instance ctrl   │
│  ipc/      handlers wiring contracts → IPC channels (IpcResult<T>)    │
└────────────────────────────────▲───────────────────────────────────────┘
                                 │ contextBridge (src/preload) exposes
                                 │ window.api: ProxyQaApi (src/shared/ipc.ts)
┌────────────────────────────────┴───────────────────────────────────────┐
│  Renderer (React 19 + Zustand + Tailwind)                              │
│  Main window: Launch (default) · Sessions · History (+ run detail /    │
│  network) · Profiles · Settings (General · Browsers · Advanced ·       │
│  About; Advanced = Proxy keys, Targeting, Flags, IP check, Network     │
│  inspector, Proxy session history, Logs)                               │
│  Keys window (#/keys): the same renderer, keys view only              │
└────────────────────────────────────────────────────────────────────────┘
```

## Bootstrap order

`src/main/index.ts` is the bundle entry (`main` in `package.json` points at
`out/main/index.js`). It exists for one reason: `playwright-core` reads
`PLAYWRIGHT_BROWSERS_PATH` **once**, when its registry module is first
evaluated. If the app imported `playwright-core` before deciding where
browsers live, the registry would already have been resolved against the
default cache (`~/.cache/ms-playwright`) and later changes to `process.env`
would be ignored for `executablePath()` / `launch()`.

So `index.ts`:

1. Computes the browsers directory with `resolveBrowsersDir` from
   `browser/browsers-path.ts` (which reads `browsers.json` from disk and never
   imports `playwright-core`): explicit `PLAYWRIGHT_BROWSERS_PATH` from the
   environment wins (`env`); otherwise `<resources>/playwright-browsers` when it
   holds `INSTALLATION_COMPLETE` for chromium, firefox **and** webkit at the
   current revisions (`bundled`, the self-contained AppImage); otherwise
   packaged builds use `<userData>/data/browsers` (`provisioned`); development
   falls back to Playwright's own cache (`dev-cache`).
2. Writes the `bundled`/`provisioned` result to
   `process.env.PLAYWRIGHT_BROWSERS_PATH` (an env value is left untouched; the
   dev cache is left to playwright-core's own default).
3. When `<resources>/webkit-libs` exists (Linux), exports
   `PROXY_QA_WEBKIT_LIBS=<dir>` and sets
   `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` (Playwright's `ldd` check
   runs with the main-process environment and would not see the bundled
   libraries). `BrowserManager` prepends that directory to `LD_LIBRARY_PATH`
   for **WebKit** launches only.
4. Only then imports `./main`, which transitively imports `playwright-core`.

`BrowserProvisioner` applies the same `resolveBrowsersDir` rule and therefore
reports the identical directory plus `source` and `installable`
(`false` for `bundled`: the resources are read-only and `install()` is refused
with `INVALID_INPUT`). `setup.status()` never lists `browsers` as pending for a
bundled build.

`main.ts` then runs in this order (any failure is shown in a native error box
and the app exits; it never dies silently):

1. Privileged scheme registration (`proxyqa:` for screenshots) and the
   single-instance lock, before `ready`.
2. `resolveAppPaths` → `.env` lookup (`config/env.ts`, **development only**:
   skipped entirely when `app.isPackaged`) → `openDatabase` (migrations) →
   `createLogger`. One secret registry feeds both the logger and the IPC
   sanitiser; anything registered later (vault contents, provider credentials,
   candidate credentials under test) is redacted everywhere.
3. Process toolkit (`system/processes.ts`) → `BrowserProvisioner` →
   live-sessions store → `IpChecker` → `DataImpulseProvider` (a development
   `.env` is applied as source `env` when present) → `LocationsService` →
   `ProxyManager` → `ProfileManager` → `BrowserManager` → `Launcher` →
   smoke launcher + install executor → `TaskManager` → clean-up of browsers a
   crashed run left open (`cleanupOrphanedSessions`, bounded to 20 s).
4. After `ready` (Electron `safeStorage` is only usable from here):
   `readMachineIdentity` → `selectKeyWrapper` → `InstallStateStore`
   (`install.json`) → `createCredentialVault`. Credential precedence is then
   applied — vault (decrypted and holding credentials) → `.env` → none — and
   re-applied on every `vault.onChange`. One INFO line
   `credential vault: backend=… decryptOk=… source=…` plus one WARN per vault
   warning. **No proxy test runs at startup.**
5. Screenshot protocol handler, CSP header, IPC handlers, main window
   (`contextIsolation`, `sandbox`, no `nodeIntegration`).

### `.env` lookup order (development only)

Packaged builds never read `.env`; the encrypted vault is their only
credential source. In development the first existing file wins; variables
already present in the process environment are never overridden.

1. `$(dirname "$APPIMAGE")/.env` — only when `APPIMAGE` is set
2. `%PORTABLE_EXECUTABLE_DIR%\.env` — only when `PORTABLE_EXECUTABLE_DIR` is set
3. `<directory of the executable>/.env` (`node_modules/electron/dist` in
   development)
4. `<project directory>/.env` — development only (`npm run dev`)
5. `<userData>/.env` — always checked last

Candidates 1 and 2 remain in `defaultEnvCandidates`, but `APPIMAGE` and
`PORTABLE_EXECUTABLE_DIR` are only set by the packaged AppImage / portable EXE,
which skip the lookup entirely, so in practice they never apply.

## Contracts

All module boundaries are declared in two files. Nothing else is shared.

| File | Purpose |
| --- | --- |
| `src/shared/types.ts` | Domain types + Zod schemas. Imported by main **and** renderer; no Node/Electron imports. |
| `src/shared/ipc.ts` | Invoke channels (`IPC`), push events (`EVENTS`) and the exact `window.api` shape (`ProxyQaApi`). |
| `src/main/contracts.ts` | Main-process module interfaces and `AppException`. |

### Module map (`src/main/contracts.ts`)

| Interface | Implemented in | Responsibility |
| --- | --- | --- |
| `AppException` | `contracts.ts` | Error carrying an `AppErrorCode`; converted to `IpcResult` failure at the IPC boundary. Messages are human-readable and never contain secrets. |
| `Logger` | `logging/logger.ts` | Structured INFO/WARN/ERROR entries, persisted via `LogRepository`, pushed to the renderer, redacted through `logging/redact.ts`. `registerSecret()` makes a value unprintable everywhere. |
| `Database` | `database/index.ts` | Opens `<userData>/data/proxy-qa.sqlite` with `node:sqlite`, applies `database/schema.ts` migrations and exposes the repositories below. |
| `ProfileRepository` | `database/repositories/profiles.ts` | CRUD for QA profiles, including the v3 columns `proxy_pool` (a product key of the profile's provider), `target_json` (JSON `GeoTarget`), `sticky_ttl_minutes` and `ephemeral`, and the v8 column `provider_id`. `proxy_mode` is `none` / `sticky` / `rotating`; a legacy `dataimpulse-*` value (written by an older build) is read as the neutral mode. Ephemeral rows are created by Quick Launch and hidden from the Profiles page unless "Save as profile" was ticked. Deleting a profile also deletes its `proxy_sessions` row (migration v2); its `test_runs` are kept with `profile_id = NULL` so history survives. |
| `ProxySessionRepository` | `database/repositories/proxySessions.ts` | One sticky-session row per profile (plus one raw-gateway row) with the provider it was tested through (`provider`, from `ProxySessionContext.providerId`; a changed provider resets the cached result like a changed pool), last IP/geo/status, (v2) `country_code`, (v3) `pool`, `target_json`, the `targeting_string` sent and the `target_match` verdict, and (v4) the exit IP's `postal_code`. Never stores credentials. |
| `TestRunRepository` | `database/repositories/testRuns.ts` | One row per browser launch (status, IP, screenshot, lead/certificate IDs) plus (v8) `provider` (NULL for a direct run), (v3) `pool`, `target_json`, `targeting_string` and `target_match`, and (v4) `postal_code`, `location_attempts`, `location_max_attempts` and `location_warning` from the location re-roll. |
| `NetworkRepository` | `database/repositories/network.ts` | Captured requests per run, including extracted IDs from JSON bodies. |
| `SettingsRepository` | `database/repositories/settings.ts` | `AppSettings`, stored as one `app_settings` row per key (JSON value) and validated key by key, so one corrupt value falls back to its default without discarding the others; `update()` merges a patch (`AppSettingsPatchSchema`, which — unlike Zod 4's `.partial()` — never fills in defaults for absent keys). New keys (`singleSessionMode`, `extraChromiumArgs`, `providerOptions`, `defaultProviderId`, `defaultProxyPool`, `defaultTargetCountry`, `locationMatchPolicy`, `locationMatchAttempts`) load with their Zod defaults from older documents. On creation, `migrateLegacySettings()` moves the global `targetingEncoding` row of earlier versions into `providerOptions.dataimpulse.encoding` (an encoding already there wins; a corrupt value is dropped) and deletes the legacy row, in one transaction; a failure leaves the row for the next start. |
| `LogRepository` | `database/repositories/logs.ts` | Log rows with pruning. |
| `CredentialVault` | `security/credential-vault.ts` | Encrypted proxy credentials: `<userData>/vault/proxy-credentials.vault` (AES-256-GCM, header `{v, alg, installId}` bound as AAD) with the key in `<keys>/<installId>.key`, wrapped by a `KeyWrapperBackend`. Keyed by **(provider id, product)**: `get(providerId, product)`, `clear(providerId, product)`, `save(input)` with `input.providerId`. Decrypted payload v3 `{ v: 3, providers: { <id>: { products: { <key>: { host, port, username, password, sessionTemplate, extras } } } } }` (`extras` = the provider's extra credential fields, inside the ciphertext like the password). Payload v2 (`{ v: 2, pools }`) and the single-credential v1 shape are read as `providers.dataimpulse` and rewritten once — **after** the original file is copied verbatim to `<vault>.v2.bak` (atomic, same directory, same permissions; a different existing backup is moved aside). If the backup or the rewrite fails, both files stay as they were, the decrypted entries remain active, `status().warnings` and the log carry a `VAULT_ERROR` message naming the backup, and every later write retries the backup first (so a v2 file without a backup is never overwritten). Atomic writes (injectable writer for tests), read-back verification on `save()`, interrupted-rotation recovery, network-free `status()` (incl. `configuredProducts`), `recordProxyTest()` for the last gateway result. Decrypted credentials stay in main-process memory; every password and `user:pass`, and every extra field the provider declares secret (`secretExtraKeys`, all extras when not given), is registered with the logger as soon as it is known. Per device only: never synced or exported. |
| `KeyWrapperBackend` | `security/key-wrapper.ts` | `os-keychain` (Electron `safeStorage`: DPAPI / macOS Keychain / libsecret / KWallet — never Linux `basic_text` or `unknown`) or `machine-derived` (scrypt N=2¹⁵ over machine id + OS username, salt sha256(installId)). Injected into the vault, so everything is testable without Electron. |
| `InstallStateStore` | `security/install-state.ts` | `<userData>/install.json`: `installId` (random UUID), `setupCompletedAt`, `lastProxyTest*`. Never holds secrets; a corrupt file is moved aside and recreated. |
| `ProxyProvider` | `proxy/providers/gateway-provider.ts` (`GatewayProvider`) + one dialect per provider (`proxy/providers/dataimpulse.ts`, `brightdata.ts`, `oxylabs.ts`, `decodo.ts`, `iproyal.ts`) — see [Proxy providers](#proxy-providers) | Exposes `name`, `displayName`, `docsUrl` and `capabilities`. For DataImpulse it builds Playwright proxy settings from the **product's** login: the targeting string (`cr.us;state.newjersey;city.newark;zip.07102;sessid.<id>;sessttl.<min>` — `__` introduces parameters, `;` separates, `.` is key/value, `,` lists values; `cr` is mandatory with state/city/zip) is appended to the login with `__`, or with `;` when the login already carries parameters; the session template from the saved credentials (else `DATAIMPULSE_SESSION_TEMPLATE` in development, else the default) still applies. Place names are encoded per `AppSettings.providerOptions.dataimpulse.encoding` (`remove-spaces` → `newjersey`, DataImpulse's published convention; `underscore`; `keep`). Exposes the parameter-only string for the "Will connect as" preview and the run/session records, tests connectivity, derives/rotates session ids. `setCredentials(list, source)` replaces the whole set of pool credentials at runtime (called whenever the vault changes); `testCredentials()` checks candidates in rotating mode without activating or persisting them. Only this module, the vault, `ProxyManager`, `BrowserManager` and the relay ever see a password. |
| `ProxyManager` | `proxy/proxy-manager.ts` | Resolves the provider for every request from `profile.providerId` through a `ProxyProviderResolver` (the `ProviderRegistry`; an unknown id fails with `INVALID_INPUT` naming it — never a fallback), then the profile's `proxyMode`, `proxyPool`, `target` and `stickyTtlMinutes` to a `ProxyConnection` (`PROXY_NOT_CONFIGURED` with the provider's display name and product label when the product has no credentials or is not offered); `providers()` returns every provider's capabilities and status (no secrets) and `getConfigStatus(id?)` one provider's status; runs tests, compares the verified exit location with the request into a `TargetMatch` (`match` / `partial` / `mismatch` / `unknown`; country first, then state; a ZIP target is checked exactly against the IP's postal code, a city target by city name), persists `ProxySession` rows, emits updates. `verifyForLaunch(profile, { policy, attempts })` is the pre-launch check: for a sticky session with a target it re-rolls the sticky id (`<id>-r<N>`, written back to the profile) while the verdict falls short of `AppSettings.locationMatchPolicy`, up to `locationMatchAttempts` IP checks, and otherwise settles on the best attempt with a warning (see "Data flow of a launch"). |
| `IpChecker` | `proxy/ip-checker.ts` | Looks up the exit IP through a proxy (or directly, for `proxyMode: none`) using ip-api / ipinfo / ipwhois with timeout and retries. `IpInfo` carries country, region, city and the **postal code** (ip-api `zip`, requested in `fields`; ipinfo / ipwho.is `postal`). |
| `ProxyRelay` | `proxy/local-relay.ts` | Per-session HTTP proxy on `127.0.0.1:<random port>` that injects `Proxy-Authorization` for the upstream gateway and forwards plain requests and `CONNECT` tunnels. See "Local proxy relay". |
| `TaskManager` | `tasks/task-manager.ts` | Serial background queue for every install / uninstall (`install-bundled`, `install-vendor`, `uninstall`). One task at a time in queue order; `enqueue` validates first (`INVALID_INPUT` for engines without an automatic method, bundled read-only builds, uninstalling a copy the app did not install) and returns an identical queued/running task instead of a duplicate. States `queued → running → verifying → done / failed`, `cancelled` from any unfinished state: cancel aborts the run's signal and terminates every child process it registered with its whole tree (`taskkill /T /F` on Windows). `isEngineBusy` (queued/running/verifying) drives the `ENGINE_BUSY` launch guard in `BrowserManager` and `Launcher`; `isEngineInstalling` (running) makes detection skip that engine's version read and path auto-save. Pushes the full list on `event:tasks-update` (progress coalesced to 200 ms); the last 20 finished tasks persist in `<data>/task-history.json`. The work itself is done by `tasks/install-executor.ts`: provisioner install (with `InstallRunOptions` signal + child pid callback) → Windows post-install sweep → verification (`verifyEngine`: executable/marker exists, non-executing version, headless smoke launch from `tasks/smoke-launch.ts` with a 30 s budget and a `--proxy-qa-session=verify-…` marker for hung Chromium browsers, path auto-saved) → sweep again; failures are `TaskFailure`s ("Installed, but failed verification: …"; Vivaldi gets its own message). |
| — | `sessions/live-sessions-store.ts`, `sessions/orphan-cleanup.ts` | `<data>/live-sessions.json` lists open sessions (`sessionId`, `runId`, `engine`, `pid`, `startedAt`), written by `BrowserManager` and cleared on a normal quit. At start-up (before the window opens) `cleanupOrphanedSessions` terminates the browsers of recorded sessions by their marker switch (never a process without it, never another session's), closes their `running` runs as `aborted` ("App was closed while this session was open") and clears the file. |
| — | `system/processes.ts` | `ProcessToolkit`: `listMarked()` (Windows: CIM `Win32_Process` through a hidden `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand`, UTF-8 JSON; Linux: `/proc`; macOS: `ps -axo`), `listUnderDir()` (Windows), `killTree()` (`%SystemRoot%\System32\taskkill.exe /T /F` or SIGTERM → SIGKILL over the descendants), `closeGracefully()` (CloseMainWindow, then Stop-Process). Script builders and parsers are pure. Used by the post-install sweep (`browser/installers/post-install-sweep.ts`: processes inside the new browser's folder created after the install began, excluding the app's own session pids and marked processes), the smoke launcher and orphan clean-up. |
| `BrowserManager` | `browser/browser-manager.ts` | Launches an engine with Playwright (`BROWSER_TYPES` is keyed by engine *family*; installed browsers use the `chromium` BrowserType with `executablePath` from `BrowserProvisioner.resolveEngine`), appending `AppSettings.extraChromiumArgs` ("Flags settings") to every Chromium-family launch, creates one `BrowserContext` per profile (device preset, locale, timezone, proxy), verifies the exit IP, navigates to the form URL, records the `TestRun`, captures screenshots and network traffic. Enforces `singleSessionMode` as the final authority: a second launch is refused with `SESSION_LIMIT` (the `Launcher` closes the open sessions first when the caller asked to replace them); one live session per profile (`INVALID_PROFILE`). `close(id)` / `closeAll()` close windows, relays and runs for the Sessions page and on quit. Logs the engine label and executable path on every launch. Session maintenance: every Chromium-family launch gets `--proxy-qa-session=<sessionId>` and the browser pid is looked up by that marker (`findBrowserPid`, exposed as `BrowserSession.browserPid`, recorded in `live-sessions.json`); a 5 s heartbeat checks `browser.isConnected()` and the open pages (the last tab closed → the windowless browser is closed and the session finalised; `lastHeartbeatAt`), a page `crash` fails the session with "The browser tab crashed", `focus()` restores a minimised Chromium window via CDP (`Browser.getWindowForTarget` / `setWindowBounds`) and calls `page.bringToFront()`. `engineBusyMessage` refuses engines with an active task (`ENGINE_BUSY`). |
| `BrowserProvisioner` | `browser/browser-provisioner.ts` | Reports every engine as a `BrowserEngineInfo` (`status().engines`, `engines()`, `redetect()`): bundled engines via `INSTALLATION_COMPLETE` markers (version from `browsers.json`), installed browsers via `engine-detect.ts`, each with `installMethod` (`bundled` / `winget` / `vendor-package` / `portable-archive` / `playwright` / `download-page` / `none`, chosen per OS in `install-support.ts`), `installNote`, `downloadUrl` and `managedInstall`. After every detection it applies the auto-save rules of `executable-paths.ts` through an `ExecutablePathStore` (the settings table: `browserExecutables` + `browserExecutableOrigins`). `installEngine(engine)` dispatches on the method — Linux user-space install (`installers/linux-user-space.ts`), `winget`, or Playwright's channel install — saves the path as `auto` and streams `BrowserInstallProgress` (`starting` → `downloading` → `extracting`/`installing` → `verifying` → `done`/`error`). `installAllMissing()` runs every automatic install in turn (`batch` index/total on each progress event); `uninstallEngine()` removes `<userData>/data/installed-browsers/<engine>`; `watchForInstall()` polls for a browser installed from its vendor page (5 s, 15 min) and emits `BrowserWatchUpdate`s. One install at a time (`INTERNAL` "already in progress"). `resolveEngine(engine)` throws `BROWSER_MISSING` with the engine's note; `install()` still runs `playwright-core install` (via Electron with `ELECTRON_RUN_AS_NODE`) for bundled engines and refuses a bundled (read-only) directory. `dispose()` cancels watchers and aborts a running download on quit. The IPC layer never calls `install` / `installEngine` / `uninstallEngine` directly: `browsers.*` channels queue tasks on the `TaskManager`, which passes an `AbortSignal` and an `onChildProcess` callback (`InstallRunOptions`); a cancelled Playwright download removes engine folders that never got their `INSTALLATION_COMPLETE` marker. `isEngineBusy` (the running task) keeps detection from reading the version or auto-saving / pruning the path of an engine being installed. |
| `EngineDetector` | `browser/engine-detect.ts` | Finds installed Chromium-based browsers: per-platform candidate lists (`%VAR%` / `$VAR` expansion, deduped), `which`-style `PATH` scan (no child process), saved path (`AppSettings.browserExecutables[engine]`, wins when the file exists → source `settings` for the user's own path, `auto-saved` for one the app saved), then the app's user-space installs (manifest `<engine>/.proxy-qa-install.json`), then the version through `browser/version-probe.ts` — **never by executing the browser on Windows or macOS** (`browser/pe-version.ts` reads `VS_FIXEDFILEINFO` from the PE `.rsrc` section, falling back to the version-named sibling folder; macOS reads `Info.plist`), `<exe> --version` only on Linux (3 s timeout, never throws), cached per binary by path + size + mtime in `<data>/engine-versions.json`; an engine reported busy by the task manager is located but not probed. Results cached 60 s, keyed by the saved paths and their origins; `locate(engine)` is an uncached disk-only lookup for the install watcher; `invalidate()` forces a re-scan. Pure helpers (`candidateExecutables`, `scanPath`, `parseVersion`, `locateExecutable`) are unit-tested with an injected fs/env/platform. Imports only Node built-ins and `@shared/types`. |
| — | `browser/browsers-path.ts` | Pure helpers shared by `index.ts`, the provisioner and the browser manager: `resolveBrowsersDir` (precedence above, with `INSTALLATION_COMPLETE` checks against `browsers.json` revisions incl. `revisionOverrides`), `bundledEngineVersion`, `resolveWebkitLibsDir` (`<resources>/webkit-libs`, Linux), `webkitLaunchEnv` / `composeLdLibraryPath` (LD_LIBRARY_PATH for WebKit processes), `defaultPlaywrightCacheDir`. Imports only Node built-ins and `@shared/types` — never `playwright-core` or `electron`. |
| `ProfileManager` | `browser/profile-manager.ts` | Validates `ProfileInput` with Zod (`devicePreset` is an open string checked against the runtime catalog — `getPreset` throws `INVALID_INPUT` for unknown ids), exposes device presets (`DEVICE_PRESETS`: desktop / mobile / tablet, engine gating by family), builds ephemeral profiles for Quick Launch, guards launches (`INVALID_PROFILE`, including stored rows whose `engine` text or `devicePreset` is unknown). |
| — | `browser/device-presets.ts` | Device catalog generated at module load: every Playwright descriptor (portrait + landscape, viewport ≥ 320 px, kebab-case ids, four historical core ids kept, each descriptor once) plus curated custom Samsung/OnePlus/Xiaomi/Motorola phones and Windows/Linux/macOS-style/Chromebook/Edge-UA desktops; tablets classified by family (iPad, Galaxy Tab, Nexus 7/10, Kindle Fire, PlayBook), discontinued devices flagged `legacy`. Exports `DEVICE_PRESETS` (desktop → mobile → tablet, legacy last, natural label order), `getPreset`, `listPresets({ deviceType?, engine?, includeLegacy? })`, `randomPreset(…)` (uniform over the eligible set, legacy excluded by default, `INVALID_INPUT` when nothing matches), `buildContextOptions` / `resolveUserAgent` (desktop presets force the Chrome UA only on the bundled Chromium; mobile/tablet always use the descriptor UA). |
| Location search | main process, data in `resources/geonames/` | Loads the GeoNames US postal extract (`US.txt`: ≈41k ZIPs, ≈29.5k cities, 51 states incl. DC; © GeoNames, CC BY 4.0) once and answers `LocationSearch` queries (`mode` state / city / zip, prefix/type-to-search, limit) with `LocationEntry` rows carrying state code, city, ZIP and a typical IANA timezone for the state. `dataimpulse-states.csv` is the provider's published state spellings used by the `remove-spaces` encoding. Everything is local; nothing is fetched. |
| `AppPaths` | `config/paths.ts` | `<userData>/data/{screenshots,browsers,logs,proxy-qa.sqlite}`, `<userData>/vault`, and the key directory **outside** userData (`%LOCALAPPDATA%\ProxyQABrowser\keys`, `${XDG_DATA_HOME:-~/.local/share}/proxy-qa-browser/keys`, `~/Library/Application Support/ProxyQABrowser-keys`), both created `0700` on POSIX. |

### Dependency rules

- Modules depend on each other **only** through the interfaces above;
  `src/main/main.ts` is the composition root that instantiates everything, and
  `src/main/ipc` registers the handlers and forwards events to the windows.
- `src/shared/*` is the only code imported by both processes.
- The renderer never imports from `src/main`. It calls `window.api.*` and
  subscribes to `EVENTS.*`; each call resolves to `IpcResult<T>` and never throws.
- Anything that can contain a credential (`ProxyConnection`, decrypted vault
  contents, `.env` contents, the relay's `Proxy-Authorization` header) stays
  in the main process. The renderer receives `ProxyConfigStatus` (host, port,
  masked username, credential `source`, missing fields) and `SecurityStatus`
  (local vault health) only. `ProxyCredentialsInput` flows renderer → main
  for `security.testCredentials` / `security.saveCredentials` and is never
  echoed back; the vault emits credentials only to in-process listeners, and
  `ipc/events.ts` forwards just the resulting `SecurityStatus`.
  Partial updates from the keys window (`ProxyCredentialsUpdate`) are merged
  with the stored vault entry in main (see below).

## Manage keys window

Proxy logins are edited in a dedicated, temporary window instead of the main
window (the first-run setup is the only exception).

```
Main window                         main process                         Keys window (#/keys)
-----------                         ------------                         --------------------
security.openKeysWindow() ──IPC──▶  KeysWindowController.open()
                                     (windows/keys-window.ts)
                                     single instance: focus if open
                                     new BrowserWindow(keysWindowOptions)
                                     setContentProtection(true)
                                     hardenWindow() + loadRenderer('/keys') ──▶ App.tsx: isKeysWindowHash
                                     hard timeout 15 min                       → <KeysWindowPage/> only
                                                                               (no shell, no setup guard)
                                     security.updateCredentials(update) ◀──IPC── CredentialsForm (partial)
                                     provider/product checked against proxy.providers()
                                     mergeCredentialsUpdate(vault.get(providerId, pool), update)
                                       → ProxyCredentialsInputSchema
                                       → vault.save() → onChange
event:security-update  ◀──────────── forwardEvents (status only) ───────▶ (both windows)
                                     security.testCredentialsPartial ◀─IPC── "Test connection"
                                       → proxy.testCredentials(merged)   (nothing persisted)
                                     security.closeKeysWindow() ◀──IPC── Close / 5 min inactivity
                                     'closed' → vault.status() → broadcast securityUpdate
```

- **Window** (`keysWindowOptions`, unit-tested): `parent` = main window,
  `modal` on Windows/Linux (a plain child on macOS, where modal means a
  sheet), 560×640, not resizable / minimizable / maximizable / fullscreenable,
  `skipTaskbar`, the theme background, and the main window's
  `webPreferences` (`contextIsolation`, `sandbox`, `nodeIntegration: false`,
  `webSecurity`, same preload) plus `spellcheck: false` and
  `devTools: !app.isPackaged`. `hardenWindow()` (shared with the main window)
  denies `window.open`, blocks navigation away from the app document and
  reports load failures. `page-title-updated` is suppressed so the title stays
  "Manage proxy keys".
- **Lifetime** (`createKeysWindowController`, unit-tested with fake timers):
  one instance (a second open focuses it); the renderer closes it after 5
  minutes without input (`lib/keysWindow.ts` — one timer whose deadline moves
  on input); main closes it after `KEYS_WINDOW_HARD_TIMEOUT_MS` (15 min)
  regardless. On `closed` main only broadcasts a fresh `SecurityStatus`.
- **Provider first**: the window opens with a **Provider** select (every
  registered provider, from `proxy.providers()`); the provider's products are
  the tabs, its `capabilities.defaults` pre-fill host/port and its
  `extraCredentialFields` render as extra inputs (secret ones as password
  inputs, write-only like the password). The template section only appears
  for providers that support session templates.
- **Partial updates** (`security/credentials-merge.ts`, unit-tested): absent
  or empty host / username / password / extra field keep the stored value (the password is
  never trimmed), `sessionTemplate` absent keeps it and null/'' removes it;
  with nothing stored every field is required. The merged result is validated
  with `ProxyCredentialsInputSchema` before `vault.save()` (encrypt, write,
  read back, verify) — the renderer never needs, or receives, the stored
  username or password. Errors name the field, never a value.
- **Renderer state**: typed values live only in the keys window's
  `CredentialsForm` React state (cleared after a successful save); no store
  persists them and nothing is written to `localStorage`. The main window
  refreshes `proxy.getConfigStatus()` on every `event:security-update`.

## Local proxy relay (WebKit + authenticated proxy)

Playwright's Linux WebKit build cannot complete an HTTPS `CONNECT` tunnel
through a proxy that requires authentication: plain HTTP works, HTTPS fails
with "Connection terminated unexpectedly". Chromium and Firefox handle
`proxy.username` / `proxy.password` natively and are unaffected.

`src/main/proxy/local-relay.ts` works around this without ever handing the
credentials to the browser:

```
WebKit ──(unauthenticated, http://127.0.0.1:<port>)──▶ relay ──(+Proxy-Authorization)──▶ gw.dataimpulse.com:823
```

- `startProxyRelay(connection, logger)` binds a `node:http` server to
  `127.0.0.1` on a random port (loopback only, so nothing else on the network
  can reach it).
- Plain HTTP proxy requests (absolute-form URLs) are forwarded with the
  `Proxy-Authorization: Basic …` header injected and `Proxy-Connection`
  stripped.
- `CONNECT host:port` requests open a TCP connection to the gateway, send an
  authenticated `CONNECT`, wait for `200`, then pipe the two sockets. A `407`
  from upstream is relayed as `407 Proxy Authentication Required`; other
  failures become `502`/`504`.
- One relay per browser session, started just before `browserType.launch` and
  closed when the session is finalised, so each session keeps its own sticky
  upstream username. `activeConnections()` reports the live tunnels;
  `close()` destroys them and stops listening.
- The browser is launched with `proxy: { server: 'http://127.0.0.1:<port>' }`
  and no username/password. Log lines from the relay show only `host:port`
  targets (`describeTarget` strips any `user:pass@`).

The relay is used for WebKit sessions with a proxy. Chromium and Firefox keep
using Playwright's native proxy auth.

## Data flow of a launch (non-blocking)

`browser.launch` returns as soon as the run and session records exist. The
renderer navigates to the run page immediately and renders the live steps
from `session-update` events; nothing in the UI waits on the proxy or the
browser.

1. Renderer calls `window.api.browser.launch(profileId)`.
2. IPC handler → `ProfileManager.get` + `validateForLaunch`.
3. `BrowserManager.launch` inserts a `TestRun` (`status: running`), creates
   the `LiveSession` (`starting`), emits `run-update` + `session-update` and
   **resolves the IPC call**. Everything below runs asynchronously.
4. `verifying-proxy`: `ProxyManager.resolveForProfile(profile)` →
   `ProxyConnection | null`.
   - With a proxy: `ProxyManager.verifyForLaunch(profile, { policy, attempts })`
     goes through the gateway (sticky username) and the `IpChecker`, then
     compares the exit location with the target (`TargetMatch`).
   - **Location re-roll** — only for a sticky session with a target and
     `AppSettings.locationMatchPolicy` other than `off`: while the verdict
     falls short of the policy (`state` rejects `mismatch`; `exact` rejects
     `mismatch` and `partial`), the manager derives a fresh sticky id with
     `ProxyProvider.rotateSession` (`<id>-r2`, `-r3`, …), writes it to the
     profile (ephemeral quick-launch profiles included) and checks again, up to
     `locationMatchAttempts` IP checks in total. Each re-roll is announced
     through `onProgress` → `session-update` with a `statusDetail` such as
     "Exit IP 107.77.76.91 is in New York, NY 10118 — re-rolling session
     (2/3)…" (plus an INFO log with requested vs. got; never credentials) and
     bumps `locationAttempts` on the session and the run. Each re-roll costs
     one IP-check request, no browser traffic. A failed first check fails the
     launch as before. A re-roll that fails otherwise (timeout, IP service)
     only consumes an attempt; `PROXY_DEAD` (the gateway refused the new
     sticky session — live: HTTP 503 once a thin ZIP pool's IPs were all
     pinned by sticky sessions) and `PROXY_AUTH_FAILED` stop re-rolling, and
     the warning says so. Re-rolling also stops when the launch is cancelled.
     If no attempt meets the policy, the best one wins (match > partial >
     mismatch; ties → later): its sticky id — still pinned to that IP — is
     written back, its `ProxySession` row is restored, and the session/run get
     `locationWarning` ("Could not get an exit IP in … after N attempts;
     using … (same state)"). Rotating sessions and policy `off` do exactly
     one check.
   - When the chosen sticky id differs from the one resolved in step 3, the
     browser manager re-resolves the `ProxyConnection` so the browser connects
     with the verified session. The run row gets `publicIp`, country, region,
     city, `postalCode`, `targetingString`, `proxySessionId`, `targetMatch`,
     `locationAttempts` / `locationMaxAttempts` and `locationWarning`. The
     session carries `ip`, so the renderer shows **PROXY READY** (exit IP
     facts, ZIP next to the city, "attempt N of M" after a re-roll) before any
     window opens, or **PROXY FAILED** with the `AppError` and a Retry action.
   - Without a proxy: the machine's own exit IP is looked up directly so the
     run record is truthful; the renderer shows **DIRECT CONNECTION**.
5. `launching`: the engine was already resolved synchronously in step 3
   (`BrowserProvisioner.resolveEngine(engine)` → `BROWSER_MISSING` with an
   actionable message, before any run row exists), then
   `browserType.launch` — the family's BrowserType; installed browsers add
   `executablePath`; WebKit + proxy goes via the local relay — and one
   `BrowserContext` built from the device preset, locale, timezone and
   viewport. Launch + context + first page share one deadline
   (`DEFAULT_LAUNCH_TIMEOUT_MS`, 45 s): a browser that hangs under automation
   (Vivaldi stalls at page creation) fails with `BROWSER_LAUNCH_FAILED`
   (*"<Browser> did not finish starting within 45 s …"*), the hung browser is
   closed (bounded) and anything that finishes later is closed at once.
   Playwright's own launch timeout is set a few seconds later as a backstop.
   The network inspector attaches if enabled.
6. `page.goto(formUrl)` with the configured navigation timeout; HTTP status
   and final URL are stored, status becomes `open`, and `network-entry`
   events stream while the window is open.
7. Closing the window (or `browser.close`) finalises the run (`success` /
   `failed` / `aborted`), closes the relay if one was started and emits
   `run-update`.

Errors at any step after the IPC call returned are delivered as a session
with `status: error` and an `AppError`; they never surface as a rejected
promise in the renderer.

## Quick Launch data flow (Launch page)

The Launch page is the default route and produces a `QuickLaunchInput`
(`src/shared/types.ts`): `providerId` (default `dataimpulse`), `proxyPool`
(a product key of that provider, e.g. `residential` / `mobile`, or `none`),
`target` (`GeoTarget`: `mode`, lower-case ISO-2 `country`, `state`,
`stateCode`, `city`, `zip`), `engine`, `devicePreset`, optional `startUrl`,
`sticky` (default true) with `stickyTtlMinutes`, optional `locale` /
`timezone` overrides, `saveAsProfile` + `profileName`, and
`replaceActiveSession`.

1. **Location search.** As the tester types, the renderer calls the location
   search with `{ mode, query, limit }`; results come from the bundled GeoNames
   dataset (state → `New Jersey (NJ)`, city → `Newark, NJ`, zip →
   `07102 — Newark, NJ`). Selecting one fills the `GeoTarget` and the state's
   typical timezone. **Random** location picks a uniformly random entry of the
   current mode; **Random all** also rolls pool (among configured pools),
   device (`randomPreset({ engine })`, never legacy) and browser (among
   available engines that support the device).
2. **Preview.** The renderer asks for a `TargetingPreview`: `pool`,
   `poolConfigured`, the parameter-only `targetingString`
   (`cr.us;state.newjersey;sessid.ql-20261005-7f3a;sessttl.60`) and `warnings`
   (pool not configured, state/city/zip billed 2×, or — for a direct connection
   with a target — that the target is ignored). Device/engine compatibility is
   enforced by the pickers, not by a preview warning. The login never reaches
   the renderer. Under it the strip
   states the active location policy from settings (e.g. "Re-rolls the session
   (up to 3 attempts) if the exit IP is outside New Jersey"; rotating and `off`
   say that nothing is re-rolled).
3. **Connect & Launch.** The handler validates the input, resolves the preset
   (`INVALID_INPUT` for unknown ids), resolves the provider by id
   (`INVALID_INPUT` naming an unknown one), refuses a product without keys or
   not offered (`PROXY_NOT_CONFIGURED`) and a target mode or sticky session the
   provider does not support (`INVALID_INPUT`) and an engine with an active install task
   (`ENGINE_BUSY`) before touching any open session, creates a profile — `ephemeral: true` unless
   `saveAsProfile` — with `proxyMode` `sticky` / `rotating` / `none`, the
   `providerId`, a generated `stickySessionId`, pool, target and TTL, and hands it
   to `BrowserManager.launch`. With `singleSessionMode` on and a session
   already open, the launch is refused with `SESSION_LIMIT` unless
   `replaceActiveSession` is set ("Close it and launch"), in which case the
   open session is terminated first. The engine itself is resolved by
   `BrowserManager.launch` (`BROWSER_MISSING`); an ephemeral profile whose
   launch fails synchronously is deleted again.
4. **Verify.** Steps 3–7 of the launch flow above run unchanged, including the
   location re-roll. After each IP lookup `ProxyManager` compares `IpInfo`
   (`countryCode`, `region`, `city`, `postalCode`) with the `GeoTarget` into a
   `TargetMatch` that is stored on the `ProxySession`, the `TestRun` and the
   live `BrowserSession`, together with `pool`, `target`, `targetingString`
   and the attempts made. Quick-launch names: `<Pool> · <target> · <device>`,
   or `Direct · <device>` for a direct connection (no location to name).
5. **Sessions page.** Lists `BrowserSession`s (pool, requested vs verified
   location, badge) and closes the selected sessions (`browser.close`) or all
   of them (`launcher.closeAll`);
   each termination closes the context, the browser, the relay (WebKit) and
   finalises the run.

Ephemeral profiles are ordinary `profiles` rows with `ephemeral = 1`; the
Profiles page filters them out, runs and sessions keep referencing them, and
"Save as profile" simply creates the row with `ephemeral = 0`.

## Proxy providers

Provider support is split into three parts under `src/main/proxy/providers/`
(design: `docs/superpowers/specs/2026-10-08-proxy-provider-plugins-design.md`):

- **Dialect** (`dialect.ts` types; one file per provider, e.g. `dataimpulse.ts`)
  — the only provider-specific code. Pure, stateless and synchronous:
  `compose(credentials, request, options)` returns the full connection
  (`server`, `username`, `password`, password-free `targetingString`; targeting
  may go in the username or the password), plus `targetingString()`,
  `createSession()`, `rotateSession()`, an optional
  `composeCredentialCheck()` (how candidate keys are tested) and an optional
  `isRetryableLocationFailure()` (false stops the location re-roll early;
  DataImpulse returns false for `PROXY_DEAD`, its exhausted-ZIP-pool HTTP 503).
  `capabilities` describes products, target modes, sticky-session id rules and
  TTL range, default host/port, extra credential fields, the geo billing note,
  the state allow-list file and the encoding options. A dialect never logs,
  stores credentials or does I/O.
- **`GatewayProvider`** (`gateway-provider.ts`) implements `ProxyProvider` for
  any dialect: the per-pool credential map, `setCredentials`,
  `getConfigStatus`, `testConnection`, `testCredentials`, `getCurrentIp`, the
  session-template resolution (for dialects that support templates) and secret
  registration — every saved and candidate password, secret extra fields and
  every **composed** password (some providers put parameters there).
  `DataImpulseProvider` remains as a thin subclass (`GatewayProvider` +
  `dataImpulseDialect`) for existing call sites (QA CLI, tests).
- **`ProviderRegistry`** (`registry.ts`) maps `ProviderId` →
  `GatewayProvider`. `get()` of an unknown id fails with `INVALID_INPUT` naming
  it (never a silent fallback); `list()` returns credential-free summaries.
  `main.ts` registers every built-in dialect (`getEncoding` reads
  `settings.providerOptions[id].encoding` at request time) and hands the
  registry to the proxy manager, profile manager, launcher and vault (secret
  extra-field declarations).

Neutral code (proxy manager, locations service, launcher) imports place-name
encoding and the not-configured messages from `proxy/targeting-text.ts`, never
from a dialect.

Built-in dialects (`BUILT_IN_DIALECTS`, picker order):

| Id | File | Parameters go in | Target modes | Sticky id / TTL | Verification |
| --- | --- | --- | --- | --- | --- |
| `dataimpulse` | `dataimpulse.ts` | username (`login__cr.us;state.newjersey;…`) | country, state, city, zip | profile charset; `sessttl` 1–1440 | live-tested |
| `brightdata` | `brightdata.ts` | username (`<zone username>-country-us-state-nj`, `-city-<name>`, `-city-<name>-zip-<zip>`, `-session-<id>`) | country, state, city, zip | `[a-zA-Z0-9]{1,32}`; no TTL parameter | community |
| `oxylabs` | `oxylabs.ts` | username (`customer-<user>-cc-US`, `-st-us_<state>`, `-cc-US-city-<name>`, `-cc-US-postalcode-<zip>`, `-sessid-<id>-sesstime-<min>`) | country, state (published 50-state list), city, zip | `[a-zA-Z0-9]{1,32}`; 1–1440 | community |
| `decodo` | `decodo.ts` | username (`user-<user>-country-us-state-us_<state>-city-<name>`, `-zip-<zip>`, `-session-<id>-sessionduration-<min>`) | country, state, city, zip | `[a-zA-Z0-9]{1,32}`; 1–1440 | community |
| `iproyal` | `iproyal.ts` | **password** (`<password>_country-us_state-<name>_city-<name>_session-<id>_lifetime-<N>m`) | country, state, city | exactly 8 alphanumerics; 1–10080 | community |

`capabilities.verification: 'community'` marks a dialect written from the
provider's public docs and not tested with a live account; the renderer's
provider pickers append *(community-verified)* (`providerOptionLabel` in
`renderer/src/lib/providers.ts`) and the keys window shows *"Community-verified
(not tested with a live account)"*. Each dialect's file header cites the docs
pages it follows and lists what was left out (e.g. IPRoyal ZIP targeting,
Bright Data session TTL). Shared pure helpers for these dialects (place-name
words, deterministic alphanumeric / fixed-length session ids, TTL clamping)
live in `providers/dialect-helpers.ts`; the syntax itself stays in each
dialect. Golden tables: `tests/provider-community-dialects.test.ts`.

**Adding a provider:** add one dialect file (official parameter docs URL in its
header, syntax copied from those docs), a golden-table test (request →
`{ server, username, password }` from the documented examples), its id in
`PROVIDER_IDS` (`src/shared/types.ts`) and the dialect in `BUILT_IN_DIALECTS`
(`registry.ts`). `tests/provider-dialect-contract.test.ts` then runs the
contract suite on it (session ids match the declared pattern and length,
rotation always changes the id, the targeting string never contains the
password, `compose` is deterministic, every declared target mode changes the
output). No launcher, browser-manager or QA-runtime change is needed.

**Provider selection** (rollout step 2):

- `ProxyMode` is `none` / `sticky` / `rotating`; `ProxyModeSchema` maps the
  v1.3.0 values `dataimpulse-sticky` / `dataimpulse-rotating` when reading
  SQLite rows, QA configuration backups and CLI manifests.
- Products are open `ProductKey` strings (`/^[a-z0-9-]{1,32}$/`, `none`
  reserved) validated against the provider's `capabilities.products` — by
  `ProfileManager` (`providerProblem`: unknown provider, product, target mode,
  sticky support → `INVALID_INPUT`), the security IPC handlers (before the
  vault is touched), the launcher and the proxy manager. DataImpulse keeps the
  keys `residential` / `mobile`, so stored values need no rewrite.
- `Profile.providerId` (default `dataimpulse`), `QuickLaunchInput.providerId`,
  `TestRun.provider`, `BrowserSession.provider`, `ProxySession.provider`.
- IPC: `proxy.providers()` → `ProviderInfo[]` (`id`, `displayName`,
  `docsUrl`, `capabilities`, `sessionTemplate` default or null, password-free
  `status`); `proxy.getConfigStatus(providerId?)`;
  `proxy.testConnection(null, product?, providerId?)`; credential inputs carry
  `providerId` + `pool` (product) + `extras`;
  `security.clearCredentials(providerId, product)`.
- Renderer: every provider name, product label, default gateway, extra field,
  target mode and encoding option comes from `proxy.providers()`
  (`renderer/src/lib/providers.ts`); profile editor and Launch offer only
  providers with keys (plus the current one).
- Messages name the provider: `notConfiguredMessage(displayName)`,
  `productNotConfiguredMessage(provider, product)` (`proxy/targeting-text.ts`),
  `GatewayProvider` rewrites a 407 with `proxyAuthMessage(displayName)`, the
  navigation error mapping and the launcher's geo-billing warning
  (`capabilities.targetingBillingNote`) use the provider's text.
- QA CLI: `QA_PROVIDER`, `QA_PROVIDER_PRODUCT`,
  `QA_PROVIDER_HOST/_PORT/_USERNAME/_PASSWORD`, `QA_PROVIDER_EXTRA_<KEY>`
  (`config/env.ts` `readProviderEnv`, `qa/cli-proxy.ts` `resolveCliProxy`);
  `DATAIMPULSE_PROXY_*` is an alias. Secrets are scrubbed from `process.env`
  (`scrubProxySecretEnv`) before anything launches. Manifest parsing lives in
  `qa/cli-manifest.ts` (matrix without `scenarioId`; errors as
  `path: message`).

## DataImpulse targeting

Reference syntax (docs.dataimpulse.com), produced by the DataImpulse dialect:

```
login__cr.us;state.newjersey;city.newark;zip.07102;sessid.<id>;sessttl.<minutes>
```

- `__` introduces the parameter list once; when the saved login already
  contains `__`, further parameters are appended with `;`.
- `;` separates parameters, `.` separates key and value, `,` separates
  multiple values for one key.
- `cr` (country, lower-case ISO-2) is **mandatory** whenever `state`, `city`
  or `zip` is sent. The app always sends it (default `us`,
  `AppSettings.defaultTargetCountry`).
- Multi-word names are lower-cased with spaces removed, following
  DataImpulse's published state list (`resources/geonames/dataimpulse-states.csv`);
  `AppSettings.providerOptions.dataimpulse.encoding` can switch to
  `underscore` or `keep`.
- `sessid` makes the session sticky (≈ 30 min by default); `sessttl` sets the
  interval in minutes. Rotating mode sends neither.
- State / city / ZIP filters are **billed at 2×** by DataImpulse; the preview
  warns about it.
- Residential and Mobile are separate plans with separate logins on
  `gw.dataimpulse.com:823`; the vault keeps one credential set per pool and
  the provider picks the login by `proxyPool`.
- Verification: `IpChecker` returns country, region, city and the postal code
  (ip-api `zip`, ipinfo / ipwho.is `postal`). `TargetMatch` is `match` when
  every requested level agrees (ZIP targets: the postal code equals the ZIP;
  city targets: the city name agrees), `partial` when the state matches but
  the city or ZIP does not (or no postal code was reported), `mismatch` when
  the country or the state differs, `unknown` when the lookup failed or gave
  no region. Some ZIPs have very few IPs in the pool, and carrier IPs can
  geolocate to another city or state (live: `zip.07102` returned an IP placed
  in New York, NY 10118); the location re-roll handles this for sticky
  sessions.

## Database schema (v8)

v1 created `profiles`, `proxy_sessions`, `test_runs`, `network_entries`,
`app_settings` and `logs`; v2 rebuilt `proxy_sessions` with `ON DELETE CASCADE`
and `country_code`. Migrations v3 and v4 add, without rewriting existing rows
(new columns are nullable or defaulted):

| Version | Table | New columns |
| --- | --- | --- |
| v3 | `profiles` | `proxy_pool` (`residential` default), `target_json` (JSON `GeoTarget` or NULL), `sticky_ttl_minutes` (minutes or NULL), `ephemeral` (0/1) |
| v3 | `proxy_sessions` | `pool`, `target_json` (JSON), `targeting_string` (parameters only), `target_match` (`match` / `partial` / `mismatch` / `unknown` or NULL) |
| v3 | `test_runs` | `pool`, `target_json` (JSON), `targeting_string`, `target_match` |
| v4 | `proxy_sessions` | `postal_code` (exit IP's postal code) |
| v4 | `test_runs` | `postal_code`, `location_attempts` (INTEGER, default 1), `location_max_attempts` (INTEGER, default 1), `location_warning` (TEXT) — rows from earlier versions read as one attempt out of one |
| v8 | `profiles` | `provider_id` (TEXT NOT NULL, default `dataimpulse`); `proxy_mode` values rewritten `dataimpulse-sticky` → `sticky`, `dataimpulse-rotating` → `rotating` (other values untouched) |
| v8 | `test_runs` | `provider` (TEXT, default `dataimpulse`; set to NULL for existing rows without a pool, i.e. direct runs) |
| v8 | `proxy_sessions` | no new column: the existing `provider` (v1) is now written per session instead of being fixed to `dataimpulse` |

v5–v7 add the QA tables (`qa_*`) and redact stored URLs. v8 is covered by
`tests/provider-migrations.test.ts` on a v7 fixture database with realistic
rows (sticky / rotating / direct / ephemeral profiles, proxied / direct /
orphaned runs, a profile session and the gateway row, legacy settings).

No column ever holds a login or a password; `targeting_string` starts at the
first parameter (`cr.…`).

## Build & packaging

- `electron-vite` bundles `src/main` (entry `index.ts`), `src/preload` and
  `src/renderer` into `out/`. The preload is emitted as CommonJS (`index.cjs`)
  because sandboxed preloads cannot be ESM.
- `electron-builder.config.mjs` packages `out/` + `package.json` into an asar.
  `playwright-core` is **asar-unpacked** because it spawns browser processes
  and its installer runs as a child Node process.
- **Linux (AppImage) is self-contained**: `scripts/bundle-browsers.mjs
  --platform linux --webkit-libs` (run by `npm run build:linux`) downloads the
  three Playwright engines at the pinned revisions into `build/browsers/linux`
  (headless shell removed) and the Ubuntu `libicu74` / `libflite1` / `libxml2`
  shared libraries WebKit needs into `build/webkit-libs/linux` (with
  `THIRD-PARTY-NOTICES.txt`); `linux.extraResources` ships them as
  `resources/playwright-browsers` and `resources/webkit-libs`. The AppImage is
  mounted, so the ~1 GB adds no start-up cost. See README → "Building".
- **Windows (portable `.exe`) is slim by default**: the portable target
  re-extracts its whole payload to `%TEMP%` on every launch, so bundling
  browsers would add 30–90 s per start; they are provisioned into
  `%APPDATA%\proxy-qa-browser\data\browsers` on first run instead.
  `npm run build:windows:bundled` sets `PROXY_QA_BUNDLE_BROWSERS=1`, which adds
  `build/browsers/win64` (downloaded with
  `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=win64`, so it works from Linux) as
  `win.extraResources`.
- Linux target: AppImage. Windows target: portable `.exe` **only** (no NSIS
  installer). User data stays in `%APPDATA%\proxy-qa-browser` and the vault
  key in `%LOCALAPPDATA%\ProxyQABrowser\keys`, so nothing is tied to the EXE's
  location. Scripts live in `scripts/` (see README → "Building").
- Packaged builds never read `.env` (`main.ts` skips the lookup when
  `app.isPackaged`); credentials come from the vault, entered in the
  first-run setup.
- `node:sqlite` is used directly (no native modules, so no `npm rebuild` /
  `install-app-deps` step). Electron ships Node 24 for the app; the test and
  dev tooling therefore needs Node ≥ 22.13 on the host.

## Desktop QA automation

The main-process `qa/` modules handle validated scenarios, variable/environment resolution, matrix/suite planning, bounded execution, reports, local schedules, encrypted configuration backups, recording, and visual comparisons. The renderer uses typed IPC through `window.api.qa`; it cannot run arbitrary scripts in a test browser or read arbitrary image files.

Migration 5 adds JSON-backed QA workspaces, scenarios, batches, policy, schedules and gateways plus local audit entries. Migration 6 redacts previously captured sensitive URL fields. Migration 7 adds suites and environments; legacy scenarios remain valid because variables, datasets and visual identities are optional.

A run resolves and validates every scenario/dataset before reserving the complete case budget. Each worker creates and cleans up an ephemeral profile/context. The recorder shares the browser provisioning and proxy verification runtime, records only a draft, and has a separate lifecycle that blocks automatic runs while active.

Checks (compliance, accessibility, performance) live in `qa/checks/`, with their step schemas, evidence types and summaries in `shared/qa-checks.ts` (appended to the `QaStepSchema` union as optional additions). Decisions are pure and unit-tested: `contrast.ts` (CSS colour parsing, alpha compositing, WCAG ratio), `wording.ts` (normalization and word diff), `visibility.ts` (hidden reasons from measured facts), `budgets.ts` (budgets, CLS windows, TBT, INP), `scripts.ts` (TrustedForm/Jornaya presets and URL matching). `compliance.ts`, `a11y.ts` (axe-core read from the installed package and evaluated in the main world) and `performance.ts` gather facts in the page with read-only DOM calls. The executor calls `prepareChecks` before the first navigation (performance observers as an init script; Chromium-only CDP network throttling) and `runCheckStep` for check steps, which are never healed; `checks/report.ts` adds them to JUnit and HTML exports.

Self-healing selectors live in `qa/healing.ts`: pure functions order and validate recorder fallbacks, translate them to Playwright selectors, split one step timeout between the primary selector and its fallbacks, and accept a fallback only on exactly one match. The executor calls its small Playwright adapter for action steps only, never for assertions. **Update selector in scenario** sends batch/case/step identifiers; the main process derives the new selector from the saved scenario's own fallback.

Origin isolation lives in `qa/navigation.ts` (`navigationGuard`, a context route installed by the executor and the recorder). Non-navigation requests always `route.fallback()`. A navigation to an unapproved origin is aborted. Every other document is fetched with `route.fetch({ maxRedirects: 0 })`, because Playwright routes only the first request of a redirect chain. Each 3xx is decided by the pure `decideDocumentRedirect` in `security/redirects.ts`, in this order: the scenario's `followRedirects` (optional, absent = follow; `false` blocks every document redirect), a valid http(s) Location, an approved target origin, the 10-hop limit, then method semantics. A followed 301/302/303, or a 307/308 of a `GET`, is fulfilled with the shared trampoline page. The browser then starts a fresh navigation, which the guard routes and checks again; a small map carries the hop count across those navigations so loops stop. A same-origin 307/308 of a `POST` is re-sent inside the route with the same method and body, and the document keeps the original URL. Cross-origin it is blocked. The guard reports each hop through `onRedirect`. The executor stores the hops, redacted, as `QaExecution.redirects` and `QaStepResult.redirects`; `qa/report-redirects.ts` turns them into HTML and JUnit lines. Per page, `qa/page-tracker.ts` tracks main-frame navigation requests still waiting for a response and the chain the guard is following; the executor waits, after the start navigation and after each step, until both are done (a blocked hop or failed redirected navigation fails the step), and `assertStatus` first allows a 0.5 s grace for a navigation the previous action scheduled. As a result the page's last status, and therefore `assertStatus`, reflects the final document; a trampoline response only stands in for the 3xx it replaces.

Real-world forms (schemas in `src/shared/qa-targets.ts` and `src/shared/qa-fixtures.ts`, all new fields optional): action steps take an optional `frame` path of iframe selectors that `qa/frames.ts` resolves to a Playwright frame, checking every level's document origin against the approved origins before the (healing) locator runs in that frame. `switchPage` steps select `main` or `popup:n`; `qa/pages.ts` numbers the context's new pages in opening order, and every page gets the same evidence listeners and tracker, while the context-level guard already routes pop-up navigations. `upload` steps reference `fixtures` stored in the scenario (base64, ≤ 5 × 2 MB, ≤ 6 MB total, sanitized names); `qa/fixtures.ts` writes them to the attempt's evidence folder (0600, `wx`) for `setInputFiles` and deletes them afterwards, and reads a file chosen in main's own dialog once for the `qa:choose-fixture` IPC call (the renderer never sends a path). Chromium and WebKit omit file bytes from intercepted multipart bodies, so the guard's optional `requestBody` hook lets the executor refill empty file parts with the matching fixture (`qa/upload-body.ts`) before `route.fetch`; URL and headers are unchanged. The recorder computes frame paths and pop-up numbers from Playwright's frame tree (never from the page), ignores frames whose chain includes an unapproved origin, listens on `window` so a pop-up's first document (which reuses its about:blank window) is covered, and keeps its pure step logic in `qa/recorder-capture.ts`. The editor's form logic, including `followRedirects` and fixtures, lives in `renderer/src/lib/scenarioForm.ts`.

Visual comparisons use bounded PNG decoding and pixelmatch. Approved baseline keys include stable scenario/dataset identity and browser/platform settings. Approval and image preview accept batch/case/step identifiers rather than caller-supplied paths, validate real filesystem boundaries, and retain the comparison's baseline screenshot in that run's evidence. Baseline PNGs are outside automatic evidence retention; CLI imports them into temporary storage from validated packs.

## Site access tokens

`src/main/site-access/` is a self-contained module that sends an operator-defined secret header to the exact origins the operator lists (allowlisting the operator's own QA traffic on their own WAF/CAPTCHA/fraud stack; never evasion):

| File | Role |
| --- | --- |
| `matcher.ts` | Pure: exact-origin matching (`createSiteAccessMatcher`), conflict detection (same header name to the same origin). Origin normalisation and header deny-list live in `src/shared/site-access.ts` (shared with the renderer). |
| `store.ts` | Per-device JSON file `<data>/site-access-tokens.json`; values encrypted with `safeStorage` (same keychain policy as custom gateways), registered with the log redactor on load/save; masked summaries only. |
| `attach.ts` | Playwright adapter `attachSiteAccessRules(context, rules)`: a context-level terminal route performs tokenized requests through `route.fetch({ maxRedirects: 0 })` and fulfills them (document redirects become a fresh navigation through the shared trampoline in `src/main/security/redirects.ts`, sub-resource redirects are fulfilled as 3xx on Chromium/Firefox and failed on WebKit), plus a page-level decorator that adds the header as a fallback override before any other context route. |
| `ipc.ts` | The `siteAccess` IPC namespace (`status`, `save`, `setEnabled`, `delete`); never returns a value. |
| `index.ts` | `createSiteAccess({ file, logger })` → `{ store, unlock(encryption), attach(context, onNote) }`. |

Call sites (one line each): `browser-manager.ts` `openContext` (every manual engine, including installed vendor browsers and the WebKit relay path), `qa/runtime.ts` session factory (shared by QA automation and the recorder), `main.ts` wiring, `ipc/index.ts` registration. The renderer section is `components/settings/SiteAccessSection.tsx` with pure form logic in `lib/siteAccess.ts`.

Route composition rule: Playwright runs context routes in reverse registration order, and a header added with `continue`/`fallback` is re-sent on redirect hops by every engine. Any other route handler that lets a request through must therefore use `route.fallback()` (never `route.continue()`), so a tokenized request always reaches the terminal handler; `qa/navigation.ts` follows this rule. The QA guard performs document requests itself, with the headers the page decorator added for that request's own origin. It never adds a header. It follows a redirect only as a fresh navigation through the trampoline, so the decorator decides again for the next origin. It re-sends a request itself only for a same-origin 307/308, where the token match is identical. An unapproved hop is aborted before any request is made. `tests/site-access-browser.test.ts` verifies, per installed engine, that a 302 from an allowlisted origin never delivers the header to another origin. `tests/qa-redirects-browser.test.ts` checks that an approved A → B → A chain sends the header only to the listed origin A, and that an unapproved origin receives nothing.

The CLI runner (`qa/cli.ts`) does not pass an attacher: tokens are a desktop, per-device feature.
