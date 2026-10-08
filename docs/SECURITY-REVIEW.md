# Release and website security review — 2026-10-08

This is an implementation review and automated verification record, not a penetration-test certification of the whole server.

## Verified controls

- Public downloads and release information; per-handler Bearer authorization for uploads and publication. An absent/short admin token fails closed.
- Production administration requires HTTPS forwarded by the private reverse proxy. Foreign browser origins are rejected. Next.js HTML uses per-request CSP nonces; JSON/download responses use `nosniff`.
- Strict stable version, filename, app identity, platform, size, checksum, and signed URL validation. Filenames cannot access arbitrary server files. Asset hashing opens files without following symbolic links.
- Streaming bounded uploads, streaming asset hashing, streaming downloads, and single byte-range support. Partial or oversized uploads cannot be published.
- Publisher-pinned Ed25519 signatures in the desktop app and server. Desktop downloads reject redirects and cross-origin asset URLs, recheck size/hash, then reverify the prepared restart file. Downgrades and overwriting published versions are rejected.
- Publication is serialized with filesystem leases and switches the current pointer only after both signed platform files pass verification. Existing downloads remain available during publication failures.
- Website service runs as an unprivileged account with a hardened systemd unit. Code is root-owned; release storage is separate and writable only to the service/root. Publisher private keys and source `.env` are excluded from browser builds and website deployment archives.
- SSH uses a dedicated deployment key, known-host verification, and a restricted public authorized-key entry. Official GitHub Actions are pinned to immutable commits. CI receives hashes from build-job outputs rather than re-signing untrusted server metadata.
- Production dependency audits reported **0 advisories** for the website and desktop production dependency trees at this review. Electron/React build and renderer dependencies are also covered by the full audit, described below.

## Remaining limitations

The full desktop development dependency audit has **five high-severity entries**, all propagated from `braces` through Tailwind 3's pattern-matching/build dependencies. The upstream advisory lists no patched braces version. The existing build uses trusted repository patterns; these packages are not part of the website's deployed production dependency tree and are not used by the release API. Keep build inputs trusted and monitor the upstream fix. Migrating the existing desktop CSS to Tailwind 4 is a separate compatibility change, not something an automatic forced audit downgrade should perform. Reference: [upstream braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).

The Electron downloader logging chain was updated to `global-agent` 4.1.3, removing eight moderate transitive audit findings from the build toolchain. The packaged release build was rerun with that override.

Ed25519 release signing is separate from Windows Authenticode signing. No Windows code-signing certificate was supplied. Windows may still show an unknown-publisher/SmartScreen prompt. A publisher certificate and native Windows validation are the next distribution steps; do not tell users that update signatures eliminate Windows' trust prompts. The included Windows CI smoke test must pass after the workflow is activated; the local Windows artifact was cross-built on Linux, while desktop UI/Windows behaviors were exercised with isolated fixtures and unit tests.

The existing proxy provider integration uses HTTP proxy endpoints, and the optional free ip-api geolocation endpoint uses HTTP. This website's HTTPS and local vault encryption do not encrypt every proxy transport. Changing that requires provider support and careful browser/relay compatibility verification. The server does not manage end-user proxy credentials or relay browser traffic.

Local vault encryption protects proxy secrets. Browser cookies, screenshots, traces, and other testing evidence have their own storage/retention behavior; they are not all covered by the credential vault. Raw traces can contain sensitive site inputs, as already stated in the desktop policy UI.

The release locks live in persistent storage. A hard kill or machine crash during an operation can leave a stale lock. Remove a stale lock only after confirming no upload or publication is active. An interruption after a version directory is promoted but before the pointer changes may leave an unpublished version directory; verify its manifests before manually repairing the pointer. This failure mode preserves the previous current release and never publishes unchecked data.

A compromised root account or authorized CI workflow can replace the website and service configuration. Protect the SSH key and publisher key, restrict the production environment to the main branch, review workflow changes, and keep the server patched. A stolen admin token alone cannot sign a new executable release.
