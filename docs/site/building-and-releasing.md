# Building and releasing

How to build the Windows, Linux and macOS packages, how signing works, and how signed releases are published to the download site, USB and the runner image.

This page summarizes the process. The full references are [docs/DISTRIBUTION.md](https://github.com/UbaidBinWaris/proxy_browser/blob/main/docs/DISTRIBUTION.md) (versions, USB, macOS signing), [docs/SERVER-DEPLOYMENT.md](https://github.com/UbaidBinWaris/proxy_browser/blob/main/docs/SERVER-DEPLOYMENT.md) (website and CI deployment) and [docs/CI-RUNNER.md](https://github.com/UbaidBinWaris/proxy_browser/blob/main/docs/CI-RUNNER.md#publishing) (runner image).

## Artifacts

Artifact names come from `electron-builder.config.mjs` and the `version` in `package.json`:

```text
release/Proxy-QA-Browser-<version>-x86_64.AppImage     Linux, self-contained
release/Proxy-QA-Browser-<version>-Windows-x64.exe     Windows portable (the only Windows artifact)
release/Proxy-QA-Browser-<version>-macOS-arm64.dmg     macOS, Apple silicon (also .zip)
release/Proxy-QA-Browser-<version>-macOS-x64.dmg       macOS, Intel (also .zip)
```

Packaged builds use `asar` with `playwright-core` unpacked, ship `resources/geonames` on every platform, and upload nothing (`publish: null`).

## Build commands

| Script | Result |
| --- | --- |
| `npm run build` | `out/main` (app, `qa-cli.js`, `qa-mcp.js`), `out/preload`, `out/renderer`; then checks that the two headless entries load no Electron |
| `npm run build:linux` | Bundles the Linux engines and WebKit libraries, builds, then packages the self-contained AppImage |
| `npm run build:windows` | Slim portable EXE; engines download on first run. On Windows, or on Linux with wine |
| `npm run build:windows:bundled` | Portable EXE with the engines inside (expect 30–90 seconds of start-up per launch) |
| `npm run build:mac` | DMG and ZIP for arm64 and x64, on a Mac |
| `npm run build:mac:dir` | Unpacked `.app` for this Mac's architecture, for quick local tests |
| `npm run build:all` | On Linux: the AppImage, then the EXE with local wine or Docker. On Windows: the EXE |

### Linux AppImage

```bash
npm run build:linux
```

The first run needs network access: Playwright's Linux engines at the revisions pinned by `playwright-core` (about 1 GB unpacked; the headless shell is removed) and the Ubuntu `libicu74`, `libflite1` and `libxml2` packages WebKit needs on other distributions. They are cached in `build/`, so later builds work offline; `--force` re-downloads. A missing bundle produces a slim AppImage with a warning instead of a failed build. The AppImage includes `THIRD-PARTY-NOTICES.txt` for the bundled libraries.

### Windows portable EXE

```powershell
npm ci
npm run build:windows
```

The portable target re-extracts its payload to `%TEMP%` on every launch, so the default build stays slim and downloads engines once into `%APPDATA%\proxy-qa-browser\data\browsers`. From Linux, `npm run build:all` (or `scripts/build-all.sh`, always Docker) builds the AppImage and then the EXE in `electronuserland/builder:wine` as your user; it prints `BUILD COMPLETE` only when every expected artifact exists.

### macOS DMG and ZIP

```bash
npm ci
npm run build:mac        # DMG + ZIP for arm64 and x64
npm run build:mac:dir    # unpacked .app for this Mac
```

macOS builds cannot be made on Linux or Windows. They are slim like the Windows EXE, and separate arm64 and x64 builds are produced instead of a universal app.

## Signing

### macOS

Signing settings are chosen from the environment only (`scripts/mac-signing.mjs`); nothing Apple-account-dependent is needed to build.

| Mode | Environment | Result |
| --- | --- | --- |
| Unsigned (default) | none | Ad-hoc signature (so Apple silicon runs it), no hardened runtime, not notarized; users need **Open Anyway** once |
| Developer ID signed | `CSC_LINK` and `CSC_KEY_PASSWORD` | Signed with the hardened runtime; not notarized, so Gatekeeper still warns on downloaded copies |
| Signed and notarized | The certificate plus exactly one complete set: `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (recommended), or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, or `APPLE_KEYCHAIN`, `APPLE_KEYCHAIN_PROFILE` | Signed, hardened, notarized and stapled; opens without a Gatekeeper prompt |

The build **fails** instead of silently downgrading when a credential set is partial, when two notarization sets are present, when notarization credentials come without a certificate, or when `PROXY_QA_SIGNED_RELEASE=1` is set without both a certificate and notarization. Do not publish ad-hoc builds as the regular download: every update repeats the Gatekeeper prompt and the Keychain may ask again.

### Windows

Windows builds are unsigned unless Azure Trusted Signing is configured. In CI, add the `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `AZURE_SIGN_PUBLISHER`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` secrets to the production environment; the Windows job then signs automatically and refuses to build unsigned. Locally the build reads `PROXY_QA_AZURE_SIGN_ENDPOINT`, `PROXY_QA_AZURE_SIGN_ACCOUNT`, `PROXY_QA_AZURE_SIGN_PROFILE` and `PROXY_QA_AZURE_SIGN_PUBLISHER`, which must be set together. `PROXY_QA_SIGNED_RELEASE=1` makes code signing mandatory.

No signing certificate is bundled with or generated by the project.

### Update signatures

Update manifests are signed separately with the publisher's **Ed25519** key. This is independent of Authenticode and Apple signing.

- `npm run release:init` creates the key pair once. The private key stays in the ignored `.release-keys/private-key.pem`; back it up privately and never commit it or put it on a USB drive.
- `resources/updates/public-key.pem` is committed and embedded in every build, together with the update feed URL (`PROXY_QA_UPDATE_FEED`, defaulting to the project's stable feed).
- Keep the same keys for every release. The release tool refuses to silently rotate an existing public key, because installed apps would stop trusting updates.

## Versions

The version belongs to the publisher and is shown read-only in the app. Use patch versions for fixes, minor versions for compatible features and major versions for breaking changes.

```bash
npm run release:version -- patch       # 1.4.0 → 1.4.1
npm run release:version -- minor       # 1.4.0 → 1.5.0
npm run release:version -- 2.0.0
```

The command updates `package.json`, `package-lock.json` and the CI runner version pins together, and rejects lower or inconsistent versions. Keep the package name and the app ID `com.ubaidbinwaris.proxy-qa-browser` stable; changing them breaks data paths and pins.

## Release through CI (recommended)

```bash
npm run release:version -- minor
# add notes for the new version to resources/release-notes.json
git commit -am "Release 1.5.0" && git push origin main      # runs the checks only
git tag v1.5.0 && git push origin v1.5.0                     # builds, tests and publishes
```

Pushes to `main` run the verification workflows but never publish. A `v*` tag runs `deploy.yml`, which:

1. Verifies the signing and deployment secrets in a preflight job.
2. Builds and tests the Windows EXE, the Linux AppImage and the website, runs the native Windows smoke test, and performs a real update on Windows (old build, signed update, restart, new build finishes). Publishing waits for all of them.
3. Hashes each artifact in its build job, signs the manifests in the publishing job, transfers the files to the server's staging area and publishes both platforms atomically after the server re-verifies sizes, hashes and signatures.

Published versions cannot be overwritten or downgraded; tag a new version instead. The same tag also builds and publishes the runner image (`runner-image.yml`) after a smoke test. One-time GitHub environment and secret setup is described in [docs/SERVER-DEPLOYMENT.md](https://github.com/UbaidBinWaris/proxy_browser/blob/main/docs/SERVER-DEPLOYMENT.md#github-actions-setup--required-once).

macOS is built and smoke-tested by `macos.yml` on every push and pull request, but `deploy.yml` does not publish macOS yet. The steps to add it are in [docs/DISTRIBUTION.md](https://github.com/UbaidBinWaris/proxy_browser/blob/main/docs/DISTRIBUTION.md#publishing-macos-releases-not-enabled-yet).

## Local and USB releases

1. Add notes for the new version to `resources/release-notes.json`.
2. Run `npm run verify` and the desktop smoke scripts.
3. Build both platforms with `npm run build:all`, or `build:linux` and `build:windows` on their own systems.
4. Test Windows with `node scripts/windows-smoke.cjs` on a Windows computer.
5. Run `npm run release:usb` **after both builds finish**. It signs the current version's binaries and writes `Proxy-QA-Browser-Update.json` and `SHA256SUMS-<version>.txt`. macOS DMG or ZIP files of the same version in `release/` are added as optional `macAssets`.
6. Copy the executable, the JSON and the checksums to the USB drive. Never rename an older binary to a newer version.

`npm run release:server` produces the manifests for a manual upload to the download server instead; see [docs/SERVER-DEPLOYMENT.md](https://github.com/UbaidBinWaris/proxy_browser/blob/main/docs/SERVER-DEPLOYMENT.md#manual-local-build-and-direct-upload).

## Verification and smoke tests

| Check | Where |
| --- | --- |
| `npm run verify` (typecheck, lint, tests, build) | Locally and in `linux.yml` |
| `scripts/desktop-smoke.mjs`, `scripts/first-run-smoke.mjs`, `scripts/launcher-ui-smoke.mjs` | Native desktop smoke tests with a temporary app directory and a local form server (Linux CI runs them under Xvfb) |
| `scripts/windows-smoke.cjs` | Packaged Windows app: key backend, no browser windows from detection, first-run downloads, launches, persistence (`windows-smoke.yml`) |
| `scripts/macos-smoke.mjs` | Packaged macOS app: bundle, signature, Keychain, detection, first-run download, a direct session (`macos.yml`) |
| `scripts/update-smoke.mjs` | A real update between two packaged builds with a throwaway publisher key; blocks publishing in `deploy.yml` |
| `secret-scan.yml` | Scans pushes and pull requests for committed secrets |

## The download website

The Next.js site in `app/webapp` serves public downloads, checksums, release notes and the update feed, and accepts protected uploads. It runs as an unprivileged service behind an HTTPS reverse proxy. Publication requires the Windows and Linux files plus two matching signed manifests; macOS files are optional extras. For local development:

```bash
npm ci --prefix app/webapp
npm run webapp:dev
```

Server preparation, storage layout and operations are in [docs/SERVER-DEPLOYMENT.md](https://github.com/UbaidBinWaris/proxy_browser/blob/main/docs/SERVER-DEPLOYMENT.md), and the current security scope in [docs/SECURITY-REVIEW.md](https://github.com/UbaidBinWaris/proxy_browser/blob/main/docs/SECURITY-REVIEW.md).
