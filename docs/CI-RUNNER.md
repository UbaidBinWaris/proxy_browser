# CI runner: Docker image and GitHub Action

The headless runner (`npm run qa`, built to `out/main/qa-cli.js`) executes a
scenario or suite manifest exported from the desktop app and writes JSON, JUnit
XML and HTML reports. This page covers two ways to run it without installing
anything but Docker:

- the **runner image** `ghcr.io/ubaidbinwaris/proxy-qa-runner` (`docker/runner/Dockerfile`), and
- the reusable **GitHub Action** `UbaidBinWaris/proxy_browser/action`.

The same image also runs the stdio **MCP server** for AI assistants
(`out/main/qa-mcp.js`); see [MCP server](MCP-SERVER.md#docker).

The manifest format, `--environment` and `--baselines` are described in
[Desktop automation → CI command-line runner](ENTERPRISE-DESKTOP.md#ci-command-line-runner).
Use the runner only on sites you own or are contracted to test.

## Runner image

| | |
| --- | --- |
| Base | `mcr.microsoft.com/playwright:v1.63.0-noble`, pinned by digest. The tag always matches `playwright-core` in `package-lock.json` |
| Contents | Node 24, Chromium, Firefox and WebKit (`/ms-playwright`), `out/main` (the CLI and the [MCP server](MCP-SERVER.md)), `resources/geonames` and the six production dependencies. No credentials, no `.env`, no desktop vault |
| User | `pwuser` (uid 1001, non-root); working directory `/work` |
| Entrypoint | `node /opt/proxy-qa-runner/out/main/qa-cli.js` (no arguments prints `--help`) |
| Size | ≈ 3.57 GB unpacked, ≈ 0.96 GB compressed (the runner adds ≈ 29 MB to the Playwright base) |
| Platform | `linux/amd64` |

Installed vendor browsers (Chrome, Edge, Brave, …) are not in the image; use
`chromium`, `firefox` or `webkit` profiles and matrix engines.

### Run it

```bash
docker run --rm --init --ipc=host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/work" \
  ghcr.io/ubaidbinwaris/proxy-qa-runner:1.4.0 \
  --config /work/suite.json --environment Staging --output /work/qa-results
```

- `--init` reaps browser processes; `--ipc=host` avoids Chromium running out of shared memory.
- `--user "$(id -u):$(id -g)" -e HOME=/tmp` makes the reports belong to you. Without
  it the container writes as uid 1001, and the CLI creates the output directory
  with mode `0700`.
- Add `--network host` (Linux) when the site under test runs on the host's
  `localhost`.
- Paths in `results.json` are container paths. Mount the directory at the same
  path on both sides (`-v "$PWD:$PWD" -w "$PWD"`) if you want them to be valid on the host.

Proxy settings are passed **by name** so the values never appear on the command
line or in your shell history:

```bash
export QA_PROVIDER_USERNAME=... QA_PROVIDER_PASSWORD=...   # from your secret store
docker run --rm --init --ipc=host -e QA_PROVIDER -e QA_PROVIDER_HOST -e QA_PROVIDER_PORT \
  -e QA_PROVIDER_USERNAME -e QA_PROVIDER_PASSWORD -v "$PWD:/work" \
  ghcr.io/ubaidbinwaris/proxy-qa-runner:1.4.0 --config /work/suite.json
```

### Build it locally

```bash
docker build -f docker/runner/Dockerfile --build-arg VERSION=dev -t proxy-qa-runner:dev .
```

The build stage runs `npm ci --ignore-scripts` and `npm run build`; the
runtime stage copies only `out/main`, `package.json`, `resources/geonames` (for
the MCP server's location search) and production `node_modules`. `.dockerignore` keeps `.env*`, `.release-keys/`, `.deploy/`,
`*.pem`, `data/`, `release/`, `build/browsers/` and other generated folders out
of the build context. With no Buildx plugin, prefix `DOCKER_BUILDKIT=0`.

When `playwright-core` is upgraded, update the base tag and digest in
`docker/runner/Dockerfile` (`docker pull mcr.microsoft.com/playwright:v<version>-noble`
prints the digest).

## GitHub Action

```yaml
jobs:
  qa:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: UbaidBinWaris/proxy_browser/action@v1.4.0
        with:
          config: qa/signup-suite.json
          environment: Staging
        env:
          QA_PROVIDER_USERNAME: ${{ secrets.QA_PROVIDER_USERNAME }}
          QA_PROVIDER_PASSWORD: ${{ secrets.QA_PROVIDER_PASSWORD }}
```

A complete consumer workflow is in
[`examples/ci/github-workflow.yml`](../examples/ci/github-workflow.yml). The
action is a composite action for **Linux runners with Docker** (GitHub-hosted
`ubuntu-*` runners qualify). It pulls the image, runs it with the workspace
mounted at the same path, uploads the report directory, and then fails the step
when the exit code is not 0. Pin the action to a release tag or its commit SHA.

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `config` | (required) | Manifest path inside the workspace |
| `output` | `qa-results` | Report directory inside the workspace |
| `environment` | — | Environment name from the manifest (`--environment`) |
| `baselines` | — | Approved screenshot pack `.qavb` inside the workspace (`--baselines`) |
| `healing` | — | `off`, `warn` or `fail`; passed as `--healing` only when set. Requires a runner image whose CLI supports `--healing` (older images exit 2) |
| `image` | `ghcr.io/ubaidbinwaris/proxy-qa-runner:<release>` | Runner image; may be pinned by digest (`…@sha256:…`) |
| `docker-network` | `host` | Docker network; `host` lets scenarios reach services started earlier in the job |
| `upload-artifact` | `true` | Upload the report directory with `actions/upload-artifact` |
| `artifact-name` | `qa-results` | Artifact name; make it unique if the action runs several times in one workflow run |

Paths outside the workspace are rejected (exit 2) because only the workspace is
mounted into the container.

### Outputs

| Output | Description |
| --- | --- |
| `exit-code` | The runner's exit code (see below) |
| `results-json` | Absolute path of `results.json` (absent after a configuration error) |

### Exit codes

| Code | Meaning | Action step |
| --- | --- | --- |
| 0 | All cases passed | succeeds |
| 1 | At least one case failed (assertion, navigation, visual change, missing baseline) | fails after uploading reports |
| 2 | Invalid configuration: manifest, flags, environment name or proxy variables rejected | fails |
| 130 | Cancelled (SIGINT/SIGTERM, e.g. the workflow was cancelled) | fails |
| 125 | Docker could not start the container (image not found, registry login) | fails |

Use `continue-on-error: true` on the step and read `steps.<id>.outputs.exit-code`
if a later step must decide what to do.

## Environment variables

Credentials are never inputs and never part of a manifest. In the action, put
them in the step's `env:` from `secrets.*`; the action forwards every variable in
the families below that is **set and non-empty** to the container by name, prints
only the names, and registers the values (except host, port, server, product
and provider name) with `::add-mask::`. New keys in these families need no
action update.

| Variables | Purpose |
| --- | --- |
| `QA_PROVIDER`, `QA_PROVIDER_PRODUCT`, `QA_PROVIDER_HOST`, `QA_PROVIDER_PORT`, `QA_PROVIDER_USERNAME`, `QA_PROVIDER_PASSWORD`, `QA_PROVIDER_EXTRA_<KEY>` | Provider gateway for profile routing: provider id, product/plan, gateway and login, plus provider-specific extras. Check `--help` of the runner image you use for the keys it supports |
| `DATAIMPULSE_PROXY_HOST`, `DATAIMPULSE_PROXY_PORT`, `DATAIMPULSE_PROXY_USERNAME`, `DATAIMPULSE_PROXY_PASSWORD` | The original DataImpulse names; they remain supported as an alias for the DataImpulse provider |
| `QA_PROXY_SERVER`, `QA_PROXY_USERNAME`, `QA_PROXY_PASSWORD` | One custom gateway for the whole run; overrides profile routing |

Leave all of them unset for a direct (unproxied) run, which is what the bundled
sample uses. The CLI loads no `.env` file and removes credential variables from
its environment before launching browsers.

## Baselines

Approve screenshots in the desktop app, export the pack (`.qavb`) and commit it
or fetch it in an earlier step, then pass `baselines:`. The CLI imports a
temporary copy; missing or changed comparisons are test failures (exit 1), and
the diff images are in the uploaded `artifacts/` directory.

## Site access tokens

Site access tokens (allowlist headers for your own staging site) are a
**desktop-only** feature: each device stores them itself, encrypted with the OS
keychain. They are not part of scenario or suite exports or backups and are not
available to the CLI, the image or the action, by design. In CI, allowlist the runner's traffic on your site instead (for
example a staging environment that accepts the CI network, or test keys from your
bot-protection vendor), configured on the site, not in the manifest.

## Security notes

- Secrets go only through environment variables (`env:` from `secrets.*`).
  Never write them into manifests, `with:` inputs, URLs or committed files.
  Exported manifests and environment URLs must not contain credentials; the
  schema rejects URLs with embedded usernames or passwords.
- The image contains no credentials. The smoke job in
  `.github/workflows/runner-image.yml` checks the image history and environment
  for proxy variable names before anything is pushed.
- Reports can contain screenshots of your forms and the test data you typed.
  Use synthetic data, keep artifact retention short, and do not run the action on
  `pull_request_target` with untrusted code.
- The container runs as a non-root user; Playwright starts Chromium without its
  own sandbox inside the container, as is usual for containerized runs.

## Sample and smoke test

`examples/ci/` contains a static form (`site/index.html`), a direct-connection
scenario manifest (`scenario.json`) with an exported `Local` environment, and
the consumer workflow above. To try it locally:

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory examples/ci/site &
docker run --rm --init --ipc=host --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:$PWD" -w "$PWD" proxy-qa-runner:dev \
  --config examples/ci/scenario.json --output qa-results
```

Expected: `passed: 1/1 cases`, exit code 0, and `qa-results/results.{json,xml,html}`.

Single-scenario manifests may add a `matrix` (`engines`, `devices`, `targets`,
`concurrency`, `retries`). The runner supplies the scenario identifier, so
`scenarioId` is not needed; older manifests that include one still load.

## Publishing

`.github/workflows/runner-image.yml` runs on `v*` tags and manual dispatch. The
**smoke** job builds the image without pushing, checks it for credentials, serves
the sample site and runs the local action against it twice (pass → exit 0 with
all three reports; failing variant → exit 1). Only then does the **publish** job
(`packages: write`) push to GHCR with the full version (for example `1.4.0`),
the minor version (`1.4`) and `sha-<short>` tags, reusing the smoke job's layer
cache. On a tag the workflow also checks that the action's default `image`
matches the tag; `npm run release:version` updates that default and the
version pins in this page and `examples/ci/` automatically.
