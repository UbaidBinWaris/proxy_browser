#!/usr/bin/env bash
# Writes the SSH settings CI uses to reach the production server. The server address, SSH user and
# port come from the production environment's secrets (DEPLOY_HOST, DEPLOY_USER, optional DEPLOY_PORT),
# so they are never stored in this public repository.
set -euo pipefail
# Failures are also written as GitHub annotations: step logs need admin rights, annotations show on the check.
# Messages name the secret, never its value.
fail() { [[ "${GITHUB_ACTIONS:-}" == true ]] && echo "::error title=Deployment SSH settings::$1"; echo "$1" >&2; exit 1; }
test -n "${DEPLOY_SSH_KEY:-}" || fail 'DEPLOY_SSH_KEY secret is not set in the production environment'
test -n "${DEPLOY_KNOWN_HOSTS:-}" || fail 'DEPLOY_KNOWN_HOSTS secret is not set in the production environment'
test -n "${DEPLOY_HOST:-}" || fail 'DEPLOY_HOST secret is not set in the production environment'
test -n "${DEPLOY_USER:-}" || fail 'DEPLOY_USER secret is not set in the production environment'
DEPLOY_PORT="${DEPLOY_PORT:-22}"
[[ "$DEPLOY_HOST" =~ ^[A-Za-z0-9.:-]+$ ]] || fail 'DEPLOY_HOST must be a host name or IP address'
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'DEPLOY_USER must be a plain user name'
[[ "$DEPLOY_PORT" =~ ^[0-9]{1,5}$ ]] || fail 'DEPLOY_PORT must be a port number'
umask 077
mkdir -p ~/.ssh
printf '%s\n' "$DEPLOY_SSH_KEY" > ~/.ssh/proxy-browser-deploy
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > ~/.ssh/known_hosts
cat > ~/.ssh/config <<SSH
Host proxy-browser-production
  HostName ${DEPLOY_HOST}
  User ${DEPLOY_USER}
  Port ${DEPLOY_PORT}
  IdentityFile ~/.ssh/proxy-browser-deploy
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  BatchMode yes
  ConnectTimeout 15
SSH
