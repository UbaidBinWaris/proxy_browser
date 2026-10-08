#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Deployment requires the authorized root SSH account.' >&2; exit 1; }
archive=${1:?Usage: install-webapp.sh archive.tar.gz commit-sha}
commit=${2:?Commit SHA required}
[[ ${commit} =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit SHA.' >&2; exit 1; }
exec 9>/opt/proxy-browser/deploy.lock
flock -x 9
base=/opt/proxy-browser
candidate=$(mktemp -d "${base}/releases/${commit}.XXXXXX")
previous=$(readlink -f "${base}/current" || true)
succeeded=0
cleanup() {
  if [[ ${succeeded} -eq 0 ]]; then
    if [[ -n ${previous} ]]; then
      ln -sfn "${previous}" "${base}/current.rollback"
      mv -Tf "${base}/current.rollback" "${base}/current"
      systemctl restart proxy-browser.service || true
    else
      systemctl stop proxy-browser.service || true
      rm -f "${base}/current"
    fi
    rm -rf "${candidate}"
  fi
}
trap cleanup EXIT
# The archive comes from the authenticated deployment job; never accept a public upload here.
tar -xzf "${archive}" -C "${candidate}" --no-same-owner
cd "${candidate}"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
mkdir -p .next/cache
chown -R root:proxybrowser "${candidate}"
chmod -R g+rX,o-rwx "${candidate}"
chown -R proxybrowser:proxybrowser .next/cache
ln -sfn "${candidate}" "${base}/current.next"
mv -Tf "${base}/current.next" "${base}/current"
systemctl restart proxy-browser.service
for attempt in {1..30}; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:4500/api/health >/dev/null && curl --fail --silent --max-time 3 http://127.0.0.1:4500/ >/dev/null; then
    succeeded=1
    echo "Website deployed: ${commit}"
    exit 0
  fi
  sleep 1
done
echo 'Website health check failed; restoring the previous deployment.' >&2
exit 1
