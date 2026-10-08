#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p .deploy
tar -czf .deploy/webapp.tar.gz --exclude='.next/cache' --exclude='.next/types' --exclude='.next/dev' -C app/webapp package.json package-lock.json next.config.ts tsconfig.json next-env.d.ts public public-key.pem src .next
echo 'Website archive ready: .deploy/webapp.tar.gz'
