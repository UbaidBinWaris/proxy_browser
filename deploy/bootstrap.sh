#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run this bootstrap as root.' >&2; exit 1; }
[[ -x /usr/bin/node ]] || { echo 'Install Node.js 24 LTS at /usr/bin/node first.' >&2; exit 1; }
/usr/bin/node --input-type=module -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)'
command -v npm >/dev/null
command -v rsync >/dev/null
command -v curl >/dev/null
getent passwd proxybrowser >/dev/null || useradd --system --user-group --home-dir /var/lib/proxy-browser --shell /usr/sbin/nologin proxybrowser
install -d -m 0755 /opt/proxy-browser /opt/proxy-browser/releases
install -d -m 0700 /etc/proxy-browser
install -d -m 0700 -o proxybrowser -g proxybrowser /var/lib/proxy-browser
install -d -m 0700 -o proxybrowser -g proxybrowser /var/lib/proxy-browser/staging /var/lib/proxy-browser/releases /var/lib/proxy-browser/locks
if [[ ! -f /etc/proxy-browser/webapp.env ]]; then
  umask 077
  admin_token=$(openssl rand -hex 32)
  cat > /etc/proxy-browser/webapp.env <<ENV
SITE_URL=https://proxybrowser.ubaidbinwaris.com
RELEASE_ROOT=/var/lib/proxy-browser
RELEASE_PUBLIC_KEY_FILE=/opt/proxy-browser/current/public-key.pem
ADMIN_TOKEN=${admin_token}
ENV
fi
install -m 0644 "$(dirname "${BASH_SOURCE[0]}")/proxy-browser.service" /etc/systemd/system/proxy-browser.service
systemctl daemon-reload
systemctl enable proxy-browser.service
echo 'Service prepared. Keep /etc/proxy-browser/webapp.env private. Deploy the website before starting the service.'
