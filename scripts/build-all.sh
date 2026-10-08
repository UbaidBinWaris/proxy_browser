#!/usr/bin/env bash
# Build the Linux AppImage natively and the Windows portable EXE via Docker.
#
# Requirements: node >= 22.13 (see package.json "engines"), docker (daemon
#               running, current user in the docker group), network access the
#               first time (the Linux step downloads ~1 GB of Playwright
#               browsers + the WebKit host libraries into build/, cached).
# Output: ./release/<Product>-<version>-x86_64.AppImage   (self-contained: browsers + WebKit libs bundled)
#         ./release/<Product>-<version>-Windows-x64.exe   (portable, slim: browsers provisioned on first run)
#
# Prints "BUILD COMPLETE" followed by the two artifact paths only when both
# exist; otherwise exits 1 with the list of missing artifacts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DOCKER_IMAGE="electronuserland/builder:wine"
NODE_MODULES_VOLUME="proxy-qa-win-node-modules"
PRODUCT="Proxy-QA-Browser"
VERSION="$(node -p "require('./package.json').version")"

# Must match electron-builder.config.mjs (linux.artifactName, portable.artifactName).
APPIMAGE="release/${PRODUCT}-${VERSION}-x86_64.AppImage"
PORTABLE_EXE="release/${PRODUCT}-${VERSION}-Windows-x64.exe"
EXPECTED=("$APPIMAGE" "$PORTABLE_EXE")

# Host caches shared with the container (Electron zips + electron-builder tools).
HOST_ELECTRON_CACHE="${ELECTRON_CACHE:-${HOME}/.cache/electron}"
HOST_BUILDER_CACHE="${ELECTRON_BUILDER_CACHE:-${HOME}/.cache/electron-builder}"

info() { printf '\n==> %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# A directory left root-owned by an earlier Docker run makes electron-builder
# fail with EACCES. Detect it up front instead of half-way through the build.
assert_writable() {
  local dir="$1" owner
  [[ -e "$dir" ]] || return 0
  owner="$(stat -c %U "$dir" 2>/dev/null || echo unknown)"
  [[ -w "$dir" ]] || die "$dir is not writable by $(id -un) (owner: $owner). An earlier Docker build probably left it root-owned. Fix: sudo chown -R \$USER:\$USER ~/.cache/electron ~/.cache/electron-builder release"
}

# --- Preflight ---------------------------------------------------------------
info "Checking prerequisites"

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
NODE_MINOR="$(node -p 'Number(process.versions.node.split(".")[1])')"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 13) )); then
  die "Node.js >= 22.13 is required (found $(node -v)). See package.json \"engines\"."
fi
echo "node $(node -v) OK"

command -v docker >/dev/null 2>&1 || die "docker is not installed. Arch: sudo pacman -S docker && sudo systemctl enable --now docker"
docker info >/dev/null 2>&1 || die "Docker daemon is not reachable. Start it (sudo systemctl start docker) and make sure your user is in the 'docker' group (sudo usermod -aG docker \$USER, then re-login)."
echo "docker OK"

# Create the host caches BEFORE any docker run so Docker never creates the
# bind-mount sources itself (it would do so as root).
mkdir -p "$HOST_ELECTRON_CACHE" "$HOST_BUILDER_CACHE"
assert_writable "$HOST_ELECTRON_CACHE"
assert_writable "$HOST_BUILDER_CACHE"
assert_writable "release"
echo "caches writable OK"

if [[ -d node_modules ]]; then
  echo "node_modules present: skipping npm ci"
else
  info "Installing dependencies"
  npm ci
fi

# --- Linux -------------------------------------------------------------------
# build:linux bundles the three Playwright browsers and the WebKit host
# libraries (scripts/bundle-browsers.mjs) before packaging the AppImage.
info "Building Linux AppImage (self-contained)"
npm run build:linux

# --- Windows via Docker ------------------------------------------------------
# Slim by default: the portable EXE re-extracts to %TEMP% on every launch, so
# browsers are provisioned on first run instead (npm run build:windows:bundled
# produces the bundled variant).
info "Building Windows portable EXE (slim) in ${DOCKER_IMAGE}"

UID_GID="$(id -u):$(id -g)"

# The named volume isolates the container's node_modules (Linux binaries resolved
# inside the wine image) from the host's. Docker creates it root-owned, so hand
# it to the host uid before running npm as that uid.
docker run --rm --user 0:0 \
  -v "${NODE_MODULES_VOLUME}:/project/node_modules" \
  "$DOCKER_IMAGE" chown "$UID_GID" /project/node_modules

# Run as the host user so every file written to ./release is owned by us (no
# chown needed afterwards). HOME points at a writable tmpfs so npm and wine can
# create their caches/prefix; the electron caches are bind-mounted into it.
# `npm ci --ignore-scripts` skips electron's own postinstall (the Linux Electron
# binary is not needed inside the container; electron-builder fetches the
# Windows zip from the shared cache).
CONTAINER_HOME="/tmp/builder-home"
docker run --rm \
  --user "$UID_GID" \
  -e "HOME=${CONTAINER_HOME}" \
  -e "WINEPREFIX=${CONTAINER_HOME}/.wine" \
  -e "ELECTRON_CACHE=${CONTAINER_HOME}/.cache/electron" \
  -e "ELECTRON_BUILDER_CACHE=${CONTAINER_HOME}/.cache/electron-builder" \
  --tmpfs "${CONTAINER_HOME}:exec,uid=$(id -u),gid=$(id -g),size=4g" \
  -v "$PWD":/project \
  -v "${NODE_MODULES_VOLUME}:/project/node_modules" \
  -v "${HOST_ELECTRON_CACHE}:${CONTAINER_HOME}/.cache/electron" \
  -v "${HOST_BUILDER_CACHE}:${CONTAINER_HOME}/.cache/electron-builder" \
  -w /project \
  "$DOCKER_IMAGE" \
  /bin/bash -c "npm ci --ignore-scripts && npm run build && npx electron-builder --win --x64 --config electron-builder.config.mjs"

# --- Verify ------------------------------------------------------------------
info "Artifacts in ./release"
ls -la release/*.AppImage release/*.exe 2>/dev/null || true

ROOT_OWNED="$(find release -maxdepth 1 -user root 2>/dev/null || true)"
if [[ -n "$ROOT_OWNED" ]]; then
  printf '\nWARNING: root-owned files in release/ (the container did not run as %s):\n%s\n' "$UID_GID" "$ROOT_OWNED" >&2
fi

MISSING=()
for artifact in "${EXPECTED[@]}"; do
  [[ -f "$artifact" ]] || MISSING+=("$artifact")
done

if (( ${#MISSING[@]} > 0 )); then
  printf '\nMissing expected artifacts:\n' >&2
  printf '  %s\n' "${MISSING[@]}" >&2
  die "BUILD INCOMPLETE: ${#MISSING[@]} of ${#EXPECTED[@]} expected artifacts missing (see above)."
fi

printf '\nBUILD COMPLETE\n'
printf '  %s\n' "${EXPECTED[@]}"
