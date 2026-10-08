# Website, releases, and automatic deployment

The Next.js app lives in `app/webapp`. Its production origin is **https://proxybrowser.ubaidbinwaris.com**. The Ubuntu service listens only on **127.0.0.1:4500** behind your existing Nginx HTTPS configuration.

## What users receive

- Windows: `Proxy-QA-Browser-<version>-Windows-x64.exe`. One file; no Node.js or development dependencies. First-run setup needs Internet to download missing browser engines. In **App & updates**, create the computer copy and shortcuts for faster later launches. Windows controls the final Start/taskbar pin action.
- Linux: `Proxy-QA-Browser-<version>-x86_64.AppImage`, with browser engines bundled. Make it executable and open it. AppImage/FUSE support depends on the Linux distribution; `--appimage-extract-and-run` is an alternative on machines without FUSE.
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

Publishing requires Windows and Linux assets plus two matching Ed25519-signed manifests. The server checks platform, version, origin, file type, exact size, and streaming SHA-256 before switching the current pointer. Published versions cannot be overwritten or downgraded. Failed uploads or verification leave the current release available. Downloads stream from disk and support single byte ranges.

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

Create a GitHub **production** environment for `UbaidBinWaris/proxy_browser` and restrict deployment branches to `main`. Add these three environment secrets in **Settings → Environments → production → Environment secrets**:

| Secret | File to use privately |
| --- | --- |
| `DEPLOY_SSH_KEY` | `.deploy/github-actions-deploy` — dedicated OpenSSH private deployment key |
| `DEPLOY_KNOWN_HOSTS` | `.deploy/github-actions-known-hosts` — verified public server host-key line |
| `RELEASE_SIGNING_PRIVATE_KEY` | `.release-keys/private-key.pem` — the existing Ed25519 publisher private key |

Use each file's complete contents, preserving newlines. Never commit these private files. Keep a separate encrypted backup of the publisher key. The dedicated deployment key's public half is authorized on the server with `restrict` to disable forwarding and PTY access. The requested SSH account is **root**, port **22**. The server's existing server→GitHub clone key is separate from this Actions→server key.

Verified server Ed25519 fingerprint during setup: `SHA256:ZGYPf6iz0GtZNQaujl7X6jatJYrD8wdqQIAjFDDLk50`. Verify it independently before replacing the known-hosts secret if the server key changes.

Push the local source changes, lockfiles, webapp, deployment scripts, and `.github/workflows/deploy.yml` to `main`. Git metadata writes and pushes are not performed by the local implementation task. Protect `main` and deployment workflow changes; the signing secret can authorize executable updates. Configure environment approvals only if you want a manual gate on every deployment.

The workflow then:

Before building, the **preflight** job verifies the signing secret against both public keys with an in-memory signing round trip, then checks the deployment SSH key and pinned server host key. It prints only success/failure messages. If it fails, fix the named secret; the build jobs will remain skipped. The website transfer alone proves SSH access but does not exercise the signing secret.

1. Chooses one shared stable version: base `major.minor.(patch + GITHUB_RUN_NUMBER)`. For base 1.3.0, workflow run 1 is 1.3.1. All jobs use the same value and copy the base release notes. Keep the same workflow identity/counter; when replacing or resetting it, bump the base minor/major version beyond already published releases.
2. Builds and tests the Windows EXE, bundled Linux AppImage, and production website. Native Windows smoke tests run on a Windows runner.
3. Hashes each desktop artifact in its build job and passes only the size and checksum through trusted GitHub job outputs.
4. Transfers large binaries directly over SSH to the server's staging folder. The website archive is also transferred directly. No desktop binaries enter Git or GitHub Actions artifact storage.
5. Signs the trusted build-job metadata in the publishing job. The server cannot substitute its own asset hash and obtain a valid publisher signature.
6. Installs the website using an atomic current symlink, restarts the unprivileged service, and restores the previous website if its local health check fails.
7. Verifies the staged files against the signed manifests and publishes both platforms atomically. The public feed is checked over HTTPS and verified against the pinned key.

A failed build stops publication. Already published versions cannot be rerun with different binaries; use a new push for a new workflow version. A failure after successful publication may leave that valid release active; inspect the feed before retrying. Old public releases remain available for existing versioned links. Remove obsolete staging files only when no corresponding build/upload is running.

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
ssh root@78.46.58.254 'mkdir -p /var/lib/proxy-browser/staging/1.3.0'
rsync -av --partial \
  release/Proxy-QA-Browser-1.3.0-Windows-x64.exe \
  release/Proxy-QA-Browser-1.3.0-x86_64.AppImage \
  release/Proxy-QA-Browser-Update.json release/update.json \
  root@78.46.58.254:/var/lib/proxy-browser/staging/1.3.0/
ssh root@78.46.58.254 'bash /opt/proxy-browser/deploy/publish-release.sh 1.3.0'
```

The `--partial` transfer retains incomplete data for retry. Publication rehashes all completed files. `/admin` also accepts the two binaries and two signed manifests; large browser uploads need the provided Nginx limits. The SSH path is preferable for resumable large transfers.

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
npm run webapp:build
bash deploy/package-webapp.sh
scp .deploy/webapp.tar.gz root@78.46.58.254:/var/tmp/proxy-browser-webapp.tar.gz
# Deploy using the actual 40-character source commit SHA:
ssh root@78.46.58.254 'bash /opt/proxy-browser/deploy/install-webapp.sh /var/tmp/proxy-browser-webapp.tar.gz YOUR_COMMIT_SHA'
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
