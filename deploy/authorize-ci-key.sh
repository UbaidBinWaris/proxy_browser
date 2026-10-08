#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 ]] || exit 1
key=$(cat)
[[ ${key} == ssh-ed25519\ * && ${key} != *$'\n'* ]] || { echo 'One Ed25519 public key is required.' >&2; exit 1; }
umask 077
install -d -m 0700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 0600 /root/.ssh/authorized_keys
line="restrict ${key}"
grep -qxF "${line}" /root/.ssh/authorized_keys || printf '%s\n' "${line}" >> /root/.ssh/authorized_keys
echo 'Dedicated Actions public key authorized; forwarding and PTY access are restricted.'
