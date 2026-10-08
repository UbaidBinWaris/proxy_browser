#!/usr/bin/env bash
set -euo pipefail
test -n "${DEPLOY_SSH_KEY:-}"
test -n "${DEPLOY_KNOWN_HOSTS:-}"
umask 077
mkdir -p ~/.ssh
printf '%s\n' "$DEPLOY_SSH_KEY" > ~/.ssh/proxy-browser-deploy
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > ~/.ssh/known_hosts
cat > ~/.ssh/config <<'SSH'
Host proxy-browser-production
  HostName 78.46.58.254
  User root
  Port 22
  IdentityFile ~/.ssh/proxy-browser-deploy
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  BatchMode yes
  ConnectTimeout 15
SSH
