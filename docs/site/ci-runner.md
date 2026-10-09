# CI runner

The headless runner executes scenario and suite manifests exported from the desktop app and writes JSON, JUnit XML and HTML reports, from the command line, a Docker image or a GitHub Action.

Use the runner only on sites you own or are contracted to test. The full reference is in [docs/CI-RUNNER.md](https://github.com/UbaidBinWaris/proxy_browser/blob/main/docs/CI-RUNNER.md).

## Export a manifest

In the desktop app, open **QA automation** and use:

- **Export for CI** on a scenario. The manifest contains `scenario`, `profile` and optionally a `matrix` (`engines`, `devices`, `targets`, `concurrency`, `retries`).
- **Export suite for CI** on a suite. It includes the suite's scenarios, profiles and workspace environments.
- **Export approved baselines for CI** for visual comparisons, which writes a `.qavb` pack.

Manifests are executable configuration. Never commit real form data or credentials in them; URLs with embedded usernames or passwords are rejected.

## Command line

From a clone of the repository:

```bash
npm ci
npm run build
npm run browsers:install
npm run qa -- --config /path/to/scenario.json --output qa-results
```

| Flag | Meaning |
| --- | --- |
| `--config <file>` | Scenario or suite manifest (required) |
| `--output <directory>` | Report directory (default `qa-results`) |
| `--environment <name>` | Environment exported in a suite manifest |
| `--baselines <pack>` | Approved screenshot pack (`.qavb`) |
| `--healing <mode>` | Override every scenario's [self-healing](/docs/self-healing) mode: `off`, `warn` or `fail` |

Examples:

```bash
npm run qa -- --config suite.json --environment "Staging" --output qa-results
npm run qa -- --config scenario.json --baselines approved.qavb --output qa-results
```

The runner uses a temporary in-memory database and fresh browser contexts. It never reads the desktop app's credential vault, loads no `.env` file, and does not download browsers itself. Imported baselines are temporary copies; missing or changed comparisons are test failures. Baselines are never approved by the runner.

### Outputs and exit codes

The output directory gets `results.json`, `results.xml` (JUnit), `results.html` and an `artifacts/` directory with screenshots and diffs.

| Code | Meaning |
| --- | --- |
| 0 | All cases passed |
| 1 | At least one case failed (assertion, navigation, visual change, missing baseline) |
| 2 | Invalid configuration: manifest, flags, environment name or proxy variables rejected |
| 130 | Cancelled (SIGINT or SIGTERM); active work stops and browsers close |

Configuration errors name the failing field and the reason, for example `QA configuration error: Invalid manifest: matrix.engines.0: Invalid option: …`. Values from the manifest or the environment are never echoed.

## Proxy credentials

Leave all proxy variables unset for a direct (unproxied) run. For profiles that use a built-in provider, pass credentials through environment variables, set from your CI secret store:

| Variable | Meaning |
| --- | --- |
| `QA_PROVIDER` | Provider ID, for example `dataimpulse`. Must match the provider named by the manifest's proxied profiles |
| `QA_PROVIDER_PRODUCT` | Product key, for example `residential` or `mobile`. Default: the product of the first proxied profile |
| `QA_PROVIDER_HOST`, `QA_PROVIDER_PORT` | Gateway; default: the provider's documented gateway |
| `QA_PROVIDER_USERNAME`, `QA_PROVIDER_PASSWORD` | Login (secret) |
| `QA_PROVIDER_EXTRA_<KEY>` | Provider-specific credential fields (secret ones are redacted like passwords) |
| `QA_PROXY_SERVER`, `QA_PROXY_USERNAME`, `QA_PROXY_PASSWORD` | One custom gateway for the whole run; overrides profile routing |

`DATAIMPULSE_PROXY_HOST`, `DATAIMPULSE_PROXY_PORT`, `DATAIMPULSE_PROXY_USERNAME` and `DATAIMPULSE_PROXY_PASSWORD` remain supported as an alias for `QA_PROVIDER=dataimpulse`; when any `QA_PROVIDER*` variable is set they are ignored with a warning. Incomplete variables, or credentials for another provider than the manifest uses, exit with code 2 naming the variables, never their values. Every credential variable is removed from the process environment before browsers launch.

[Site access tokens](/docs/site-access-tokens) are a desktop-only feature and are not available to the runner. Allowlist CI traffic on your site instead.

## Docker image

The runner image `ghcr.io/ubaidbinwaris/proxy-qa-runner` is built on the official Playwright image and contains Node 24, Chromium, Firefox and WebKit, the runner and the [MCP server](/docs/mcp-server). It contains no credentials, runs as the non-root user `pwuser`, and is published for `linux/amd64`. Installed vendor browsers (Chrome, Edge, Brave and others) are not included; use `chromium`, `firefox` or `webkit`.

```bash
docker run --rm --init --ipc=host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/work" \
  ghcr.io/ubaidbinwaris/proxy-qa-runner:1.4.0 \
  --config /work/suite.json --environment Staging --output /work/qa-results
```

- `--init` reaps browser processes; `--ipc=host` avoids Chromium running out of shared memory.
- `--user "$(id -u):$(id -g)" -e HOME=/tmp` makes the reports belong to you.
- Add `--network host` (Linux) when the site under test runs on the host's `localhost`.
- Paths in `results.json` are container paths. Mount the directory at the same path on both sides (`-v "$PWD:$PWD" -w "$PWD"`) to keep them valid on the host.

Pass proxy settings **by name**, so values never appear on the command line or in shell history:

```bash
export QA_PROVIDER_USERNAME=... QA_PROVIDER_PASSWORD=...   # from your secret store
docker run --rm --init --ipc=host -e QA_PROVIDER -e QA_PROVIDER_HOST -e QA_PROVIDER_PORT \
  -e QA_PROVIDER_USERNAME -e QA_PROVIDER_PASSWORD -v "$PWD:/work" \
  ghcr.io/ubaidbinwaris/proxy-qa-runner:1.4.0 --config /work/suite.json
```

Pin the image to a release tag or digest. To build it locally, see [docs/CI-RUNNER.md](https://github.com/UbaidBinWaris/proxy_browser/blob/main/docs/CI-RUNNER.md#build-it-locally).

## GitHub Action

The composite action `UbaidBinWaris/proxy_browser/action` runs the image on **Linux runners with Docker** (GitHub-hosted `ubuntu-*` runners qualify), uploads the report directory and fails the step when the exit code is not 0.

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

| Input | Default | Description |
| --- | --- | --- |
| `config` | (required) | Manifest path inside the workspace |
| `output` | `qa-results` | Report directory inside the workspace |
| `environment` | none | Environment name from the manifest |
| `baselines` | none | `.qavb` pack inside the workspace |
| `healing` | none | `off`, `warn` or `fail`; passed only when set |
| `image` | `ghcr.io/ubaidbinwaris/proxy-qa-runner:<release>` | Runner image; may be pinned by digest |
| `docker-network` | `host` | Docker network; `host` lets scenarios reach services started earlier in the job |
| `upload-artifact` | `true` | Upload the report directory |
| `artifact-name` | `qa-results` | Make it unique if the action runs several times in one workflow run |

Outputs: `exit-code` (the runner's exit code; 125 means Docker could not start the container) and `results-json` (the absolute path of `results.json`). To decide in a later step, set `continue-on-error: true` and read `steps.<id>.outputs.exit-code`.

Credentials are never inputs. Put them in the step's `env:` from `secrets.*`. The action forwards every set variable in the `QA_PROVIDER*`, `DATAIMPULSE_PROXY_*` and `QA_PROXY_*` families by name and masks their values in the log. Paths outside the workspace are rejected.

A complete consumer workflow is in [examples/ci/github-workflow.yml](https://github.com/UbaidBinWaris/proxy_browser/blob/main/examples/ci/github-workflow.yml).

## Security notes

- Secrets go only through environment variables. Never write them into manifests, `with:` inputs, URLs or committed files.
- Reports can contain screenshots of your forms and the test data you typed. Use synthetic data and keep artifact retention short.
- Do not run the action on `pull_request_target` with untrusted code.

## Try the sample

The repository's `examples/ci/` folder contains a static form, a direct-connection scenario manifest and the consumer workflow:

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory examples/ci/site &
docker run --rm --init --ipc=host --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:$PWD" -w "$PWD" ghcr.io/ubaidbinwaris/proxy-qa-runner:1.4.0 \
  --config examples/ci/scenario.json --output qa-results
```

Expected: `passed: 1/1 cases`, exit code 0, and `qa-results/results.{json,xml,html}`.
