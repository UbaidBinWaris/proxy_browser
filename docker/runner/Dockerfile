# Headless CI runner for Proxy QA Browser scenario and suite manifests.
#
# Build from the repository root:
#   docker build -f docker/runner/Dockerfile -t proxy-qa-runner .
# Run (the image has no credentials; pass proxy settings as environment variables only):
#   docker run --rm --init --ipc=host -v "$PWD:/work" proxy-qa-runner \
#     --config /work/suite.json --output /work/qa-results
#
# The base image MUST match the playwright-core version in package-lock.json so the
# browsers in /ms-playwright are the revisions playwright-core expects. When
# playwright-core is bumped, update the tag in the comments below and the digest
# (docker manifest inspect / docker pull mcr.microsoft.com/playwright:v<ver>-noble).
#
# Base: mcr.microsoft.com/playwright:v1.63.0-noble (multi-arch index digest; Node 24, Ubuntu 24.04,
# Chromium/Firefox/WebKit in /ms-playwright, non-root user pwuser uid 1001).
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27

# ---------------------------------------------------------------------------
# build: full dependency tree, compile out/main/qa-cli.js
# ---------------------------------------------------------------------------
FROM ${PLAYWRIGHT_IMAGE} AS build
WORKDIR /src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false
COPY package.json package-lock.json ./
# Install scripts are skipped: the CLI build needs no Electron binary and no native addon.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && test -f out/main/qa-cli.js

# ---------------------------------------------------------------------------
# prod-deps: runtime dependencies only (dotenv, pixelmatch, playwright-core, pngjs, zod)
# ---------------------------------------------------------------------------
FROM ${PLAYWRIGHT_IMAGE} AS prod-deps
WORKDIR /src
ENV npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${PLAYWRIGHT_IMAGE} AS runtime
ARG VERSION=dev
LABEL org.opencontainers.image.title="Proxy QA Browser CI runner" \
      org.opencontainers.image.description="Headless runner for Proxy QA Browser scenario and suite manifests (authorized QA of web forms you own). Writes JSON, JUnit XML and HTML reports." \
      org.opencontainers.image.source="https://github.com/UbaidBinWaris/proxy_browser" \
      org.opencontainers.image.url="https://github.com/UbaidBinWaris/proxy_browser/blob/main/docs/CI-RUNNER.md" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /opt/proxy-qa-runner
# package.json carries "type": "module", which the emitted ES module chunks need.
COPY --from=build /src/package.json ./package.json
COPY --from=prod-deps /src/node_modules ./node_modules
COPY --from=build /src/out/main ./out/main
RUN mkdir -p /work && chown pwuser:pwuser /work
WORKDIR /work
USER pwuser
ENTRYPOINT ["node", "/opt/proxy-qa-runner/out/main/qa-cli.js"]
CMD ["--help"]
