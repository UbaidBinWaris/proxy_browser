#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run this configuration as root.' >&2; exit 1; }
site=/etc/nginx/sites-available/proxybrowser.ubaidbinwaris.com
[[ -f ${site} ]] || { echo 'Configure this domain and its SSL certificate first.' >&2; exit 1; }
install -d -m 0755 /etc/nginx/snippets
backup=$(mktemp /etc/nginx/sites-available/proxy-browser-backup.XXXXXX)
cp -p "${site}" "${backup}"
# Dedicated names affect only this app's locations.
cat > /etc/nginx/conf.d/proxy-browser-limits.conf <<'CONF'
limit_req_zone $binary_remote_addr zone=proxy_browser_admin:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=proxy_browser_checks:10m rate=30r/m;
CONF
sed '/^#/d' "$(dirname "${BASH_SOURCE[0]}")/nginx.example.conf" > /etc/nginx/snippets/proxy-browser-locations.conf
python3 - "${site}" <<'PY'
from pathlib import Path
import re, sys
path = Path(sys.argv[1]); text = path.read_text()
include = 'include /etc/nginx/snippets/proxy-browser-locations.conf;'
if include not in text:
    matches = list(re.finditer(r'\blocation\s+/\s*\{', text))
    if len(matches) != 1: raise SystemExit('Expected one root proxy location; merge the provided locations manually.')
    match = matches[0]; depth = 1; end = match.end()
    while end < len(text) and depth:
        depth += (text[end] == '{') - (text[end] == '}'); end += 1
    if depth: raise SystemExit('Nginx location is not balanced.')
    text = text[:match.start()] + include + text[end:]
    path.write_text(text)
PY
if nginx -t; then
  systemctl reload nginx
  echo "Domain upload limits configured. Previous site configuration: ${backup}"
else
  cp -p "${backup}" "${site}"
  echo 'Nginx validation failed. Previous site configuration restored; service not reloaded.' >&2
  exit 1
fi
