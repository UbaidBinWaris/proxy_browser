# Website, releases, and automatic deployment

The Next.js app lives in `app/webapp`. Its production origin is **https://proxybrowser.ubaidbinwaris.com**. The Ubuntu service listens only on **127.0.0.1:4500** behind your existing Nginx HTTPS configuration.

## What users receive

- Windows: `Proxy-QA-Browser-<version>-Windows-x64.exe`. One file; no Node.js or development dependencies. First-run setup needs Internet to download missing browser engines. In **App & updates**, create the computer copy and shortcuts for faster later launches. Windows controls the final Start/taskbar pin action.
- Linux: `Proxy-QA-Browser-<version>-x86_64.AppImage`, with browser engines bundled. Make it executable and open it. AppImage/FUSE support depends on the Linux distribution; `--appimage-extract-and-run` is an alternative on machines without FUSE.
- macOS (optional, not published by CI yet): `Proxy-QA-Browser-<version>-macOS-arm64.dmg` / `-macOS-x64.dmg` (or `.zip`). The website shows a macOS card only when the published release lists them; Macs check the feed and open the website to download — see [DISTRIBUTION.md → macOS](DISTRIBUTION.md#macos).
- Existing users install 1.3.0 once to get the default online feed. Future releases are discovered when opening **App & updates**. The user chooses **Download v… and restart**. Signature, size, and checksum must pass before the executable is launched. Local data and computer-copy shortcuts are preserved.
- The website offers public downloads, SHA-256 checksums, release notes, and a **Check for updates** button. No account or proxy subscription is included.

## Storage and security boundary

| Purpose | Location |
| --- | --- |
| Source clone | `/root/proxy_browser` |
| Retained deployment helpers | `/opt/proxy-browser/deploy/` |
| Active website | `/opt/proxy-browser/current` |
| Website deployment history | `/opt/proxy-browser/releases/` |
| Private website service configuration | `/etc/proxy-browser/webapp.env` |
| Uploaded, unpublished release files | `/var/lib/proxy-browser/staging/<version>/` |
| Immutable published files | `/var/lib/proxy-browser/releases/<version>/` |
| Current release pointer | `/var/lib/proxy-browser/current.json` |

The website runs as **proxybrowser**, not root. Only the release storage and Next.js cache are writable by the service. Website code is owned by root. Port 4500 must remain private; Nginx replaces the forwarded protocol header and applies upload size, timeout, and admin rate limits.

Public API routes: `/api/health`, `/api/releases`, `/api/updates/stable`, and `/api/download/<version>/<filename>`. Administration API routes require `Authorization: Bearer <ADMIN_TOKEN>` plus HTTPS in production. Browser mutations must come from the configured origin. Authentication is enforced in each handler, independent of middleware. No shared admin token is embedded in the desktop app or client bundle.

Publishing requires Windows and Linux assets plus two matching Ed25519-signed manifests; macOS DMG/ZIP files are optional extras listed under `macAssets` in both manifests (older desktop releases ignore that key, so the required pair stays exactly two files). The server checks platform, version, origin, file type, exact size, and streaming SHA-256 of every listed file before switching the current pointer. Published versions cannot be overwritten or downgraded. Failed uploads or verification leave the current release available. Downloads stream from disk and support single byte ranges.

The publisher private key stays on your publishing computer and in the protected GitHub Actions signing secret. The server needs only the **public** verification key. `app/webapp/public-key.pem` is safe to commit and deploy. Preserve the existing key pair; silently replacing it would break trust for installed apps.

Your requested root `.env` copy belongs at `/root/proxy_browser/.env`, mode `600`. It is transferred separately over SSH and is excluded from website archives and browser builds. The web service uses `/etc/proxy-browser/webapp.env`; it does not load the source clone's `.env`. Each user's proxy credentials and browser data continue to live on their device.

## Initial server preparation

Node.js 24 LTS, npm, rsync, curl, Python 3, OpenSSL, Nginx, and systemd are required. This server already has Node.js 24 and an SSL certificate. From the updated source clone:

```bash
cd /root/proxy_browser
bash deploy/bootstrap.sh
bash deploy/configure-nginx.sh
```

`bootstrap.sh` creates the unprivileged service account, storage directories, and a random administrator token in the private service configuration. It preserves existing configuration. `configure-nginx.sh` updates only this domain's root proxy location, keeps Certbot's TLS configuration, backs up the previous site file, and validates Nginx before reloading. For a different proxy layout, merge `deploy/nginx.example.conf` manually instead.

Do not put the administrator token in chat, Git, `NEXT_PUBLIC_*`, or the desktop `.env`. Use it privately on `/admin`; refreshing the admin page clears its in-memory token. You can rotate it by editing the private service configuration and restarting the service.

## GitHub Actions setup — required once

Create a GitHub **production** environment for `UbaidBinWaris/proxy_browser`. Releases deploy from **version tags**, so under **Deployment branches and tags** choose *Selected branches and tags* and add the tag rule `v*` (plus `main` if you also start manual runs from it); without the tag rule GitHub refuses tag deployments. Add these environment secrets in **Settings → Environments → production → Environment secrets**:

| Secret | File to use privately |
| --- | --- |
| `DEPLOY_SSH_KEY` | `.deploy/github-actions-deploy` — dedicated OpenSSH private deployment key |
| `DEPLOY_KNOWN_HOSTS` | `.deploy/github-actions-known-hosts` — verified public server host-key line |
| `RELEASE_SIGNING_PRIVATE_KEY` | `.release-keys/private-key.pem` — the existing Ed25519 publisher private key |
| `DEPLOY_HOST` | The server's host name or IP address (from your private notes, e.g. `.deploy/SERVER-PRIVATE.md`) |
| `DEPLOY_USER` | The SSH user CI deploys as |
| `DEPLOY_PORT` | The SSH port (optional; 22 when unset) |

Use each file's complete contents, preserving newlines. Never commit these private files. Keep a separate encrypted backup of the publisher key. The dedicated deployment key's public half is authorized on the server with `restrict` to disable forwarding and PTY access. The server address, SSH user and port are private: store them as the production environment secrets `DEPLOY_HOST`, `DEPLOY_USER` and (optionally, default 22) `DEPLOY_PORT`; `deploy/configure-ci-ssh.sh` reads them and refuses to run without them. The server's existing server→GitHub clone key is separate from this Actions→server key.

Verify the server's Ed25519 host-key fingerprint out of band (for example on the server's console with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) before creating or replacing the known-hosts secret. Keep the server address, SSH user and fingerprint in private notes, not in this repository.

Push the local source changes, lockfiles, webapp, deployment scripts, and `.github/workflows/deploy.yml` to `main`. Git metadata writes and pushes are not performed by the local implementation task. Protect `main` and deployment workflow changes; the signing secret can authorize executable updates. Configure environment approvals only if you want a manual gate on every deployment.

The workflow then:

Before building, the **preflight** job verifies the signing secret against both public keys with an in-memory signing round trip, then checks the deployment SSH key and pinned server host key. It prints only success/failure messages. If it fails, fix the named secret; the build jobs will remain skipped. The website transfer alone proves SSH access but does not exercise the signing secret.

1. Chooses one shared stable version. A tag `vX.Y.Z` publishes exactly X.Y.Z (it must not be lower than `package.json`; release notes for that version, or the base version, must exist). A manual **Run workflow** without a tag keeps the old scheme: base `major.minor.(patch + GITHUB_RUN_NUMBER)`. All jobs use the same value.
2. Builds and tests the Windows EXE, bundled Linux AppImage, and production website. Native Windows smoke tests run on a Windows runner, and the **update-smoke** job performs a real update on Windows (old build → signed update → restart → new build finishes); publishing waits for it. Electron downloads and the Linux browser bundle are cached between runs.
3. Hashes each desktop artifact in its build job and passes only the size and checksum through trusted GitHub job outputs.
4. Transfers large binaries directly over SSH to the server's staging folder. The website archive is also transferred directly. No desktop binaries enter Git or GitHub Actions artifact storage.
5. Signs the trusted build-job metadata in the publishing job. The server cannot substitute its own asset hash and obtain a valid publisher signature.
6. Installs the website using an atomic current symlink, restarts the unprivileged service, and restores the previous website if its local health check fails.
7. Verifies the staged files against the signed manifests and publishes both platforms atomically. The public feed is checked over HTTPS and verified against the pinned key.

A failed build stops publication. Already published versions cannot be rerun with different binaries; tag a new version instead. A failure after successful publication may leave that valid release active; inspect the feed before retrying. Old public releases remain available for existing versioned links. Remove obsolete staging files only when no corresponding build/upload is running.

### Releasing

```bash
npm run release:version -- minor      # bumps package.json, lockfile and the CI runner pins
# add notes for the new version to resources/release-notes.json
git commit -am "Release 1.5.0" && git push origin main      # runs the checks only
git tag v1.5.0 && git push origin v1.5.0                     # builds, tests and publishes
```

Pushes to `main` run the verification workflows but never publish. The same tag also builds the Docker runner image (`runner-image.yml`).

### Windows code signing (optional, recommended before public releases)

Unsigned EXEs show SmartScreen's "Windows protected your PC" warning. With **Azure Trusted Signing**, add these secrets to the production environment; the Windows job then signs automatically (and refuses to build unsigned):

| Secret | Value |
| --- | --- |
| `AZURE_SIGN_ENDPOINT` | Trusted Signing account endpoint, e.g. `https://eus.codesigning.azure.net` |
| `AZURE_SIGN_ACCOUNT` | Trusted Signing account name |
| `AZURE_SIGN_PROFILE` | Certificate profile name |
| `AZURE_SIGN_PUBLISHER` | Publisher subject exactly as in the certificate profile (e.g. `CN=Your Name`) |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | App registration with the *Trusted Signing Certificate Profile Signer* role |

Without these secrets the build stays unsigned, as before.

macOS is verified by `.github/workflows/macos.yml` (unsigned build + smoke test) but is not part of this deploy workflow; signing/notarization variables and the steps to add a macOS publishing job are in [DISTRIBUTION.md → macOS](DISTRIBUTION.md#publishing-macos-releases-not-enabled-yet).

Actions and build dependencies are pinned; build scripts do not receive the publisher key. Production dependency audits run in CI. Desktop build tools are not installed on the website server.

## Manual local build and direct upload

For a later local release, increment the version, add its release notes, build both platforms, and sign:

```bash
npm run release:version -- patch
# Edit resources/release-notes.json for the new version.
npm run build:all
npm run release:server
```

Choose a local version above the currently published server version, especially after CI-generated patch releases. Use `npm run release:version -- 1.4.0` when necessary. The signing command requires the existing publisher key in `.release-keys/private-key.pem`. It creates `Proxy-QA-Browser-Update.json`, `update.json`, and the checksum file under ignored `release/`.

Upload a release (replace 1.3.0 with the actual version):

```bash
ssh <deploy-user>@<server> 'mkdir -p /var/lib/proxy-browser/staging/1.3.0'
rsync -av --partial \
  release/Proxy-QA-Browser-1.3.0-Windows-x64.exe \
  release/Proxy-QA-Browser-1.3.0-x86_64.AppImage \
  release/Proxy-QA-Browser-Update.json release/update.json \
  <deploy-user>@<server>:/var/lib/proxy-browser/staging/1.3.0/
ssh <deploy-user>@<server> 'bash /opt/proxy-browser/deploy/publish-release.sh 1.3.0'
```

To include macOS, copy the `-macOS-*.dmg`/`.zip` files built on a Mac into `release/` before `npm run release:server` (they are signed into both manifests) and add them to the `rsync` list. The `--partial` transfer retains incomplete data for retry. Publication rehashes all completed files. `/admin` also accepts the two binaries (plus optional macOS files) and two signed manifests; large browser uploads need the provided Nginx limits. The SSH path is preferable for resumable large transfers.

GitHub's 100 MiB Git-file restriction does not apply to direct transfers. GitHub Release assets are another distribution option and support files below 2 GiB each: [GitHub release asset documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases). This implementation uses your server for production downloads.

## Website-only local development and deployment

```bash
npm ci --prefix app/webapp
npm run webapp:dev
# http://127.0.0.1:4500 — no download until a release is published.
```

For a local release preview, use a separate `RELEASE_ROOT` outside `public/`, stage both signed files, and run `src/lib/publish-cli.ts` with Node's `--import tsx` from `app/webapp`. `SITE_URL` remains the configured HTTPS origin; file URLs in a signed manifest must match it.

Production website archive:

```bash
npm run brand:sync
npm run docs:sync          # docs/site/*.md, release notes and NOTICE → app/webapp/content/
npm run webapp:build
bash deploy/package-webapp.sh
scp .deploy/webapp.tar.gz <deploy-user>@<server>:/var/tmp/proxy-browser-webapp.tar.gz
# Deploy using the actual 40-character source commit SHA:
ssh <deploy-user>@<server> 'bash /opt/proxy-browser/deploy/install-webapp.sh /var/tmp/proxy-browser-webapp.tar.gz YOUR_COMMIT_SHA'
```

Releases live outside this archive and survive website deployment. Source `.env` is never copied by the automatic deployment workflow, so it cannot overwrite manually configured server secrets.

## Operations and verification

```bash
systemctl status proxy-browser.service
journalctl -u proxy-browser.service -n 100 --no-pager
curl --fail https://proxybrowser.ubaidbinwaris.com/api/health
curl --fail https://proxybrowser.ubaidbinwaris.com/api/releases
```

Check that `ss -ltnp '( sport = :4500 )'` shows `127.0.0.1`, not `0.0.0.0`. Check Certbot renewal with its normal renewal test. Back up private service configuration and release metadata alongside the publisher key; the key is backed up off-server. Monitor release storage disk space and decide a retention period for Nginx access logs.

Test commands:

```bash
npm run typecheck
npm run lint
npm test
npm test --prefix app/webapp
npm run typecheck --prefix app/webapp
npm run webapp:build
node scripts/webapp-smoke.mjs
node scripts/app-updates-ui-smoke.mjs
node scripts/computer-setup-smoke.mjs
```

The website browser smoke uses temporary signed fixtures on port 4501 and simulates the HTTPS reverse proxy locally. It verifies CSP hydration, download contents, update comparison, range responses, authorization, HTTPS enforcement, real admin uploads/publication, token clearing, and narrow layout. It does not publish fixture executables to production.

See `SECURITY-REVIEW.md` for the current security scope and remaining limitations.
