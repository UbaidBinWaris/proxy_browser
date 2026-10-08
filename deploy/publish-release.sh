#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run with the authorized root SSH account.' >&2; exit 1; }
version=${1:?Release version required}
[[ ${version} =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo 'Invalid version.' >&2; exit 1; }
folder="/var/lib/proxy-browser/staging/${version}"
[[ -d ${folder} && ! -L ${folder} ]] || { echo 'Missing staging folder.' >&2; exit 1; }
# The private publisher key is never needed on this server.
chown -R proxybrowser:proxybrowser "${folder}"
chmod -R u+rwX,go-rwx "${folder}"
cd /opt/proxy-browser/current
runuser -u proxybrowser -- env SITE_URL=https://proxybrowser.ubaidbinwaris.com RELEASE_ROOT=/var/lib/proxy-browser RELEASE_PUBLIC_KEY_FILE=/opt/proxy-browser/current/public-key.pem /usr/bin/node --import tsx src/lib/publish-cli.ts "${version}"
