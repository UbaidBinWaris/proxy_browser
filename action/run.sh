#!/usr/bin/env bash
# Runs the Proxy QA Browser CI runner image for action.yml.
#
# Inputs arrive as INPUT_* environment variables (never interpolated into the
# script). Proxy settings are passed through by NAME only (`docker run --env NAME`),
# so values never appear on a command line, in the image, or in this log.
# Writes `exit-code`, `results-json` and `output-dir` to $GITHUB_OUTPUT.
set -euo pipefail

workspace=${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is not set}
workspace=$(cd "$workspace" && pwd -P)
image=${INPUT_IMAGE:?The image input is required.}
config=${INPUT_CONFIG:?The config input is required.}
output=${INPUT_OUTPUT:-qa-results}
environment_name=${INPUT_ENVIRONMENT:-}
baselines=${INPUT_BASELINES:-}
healing=${INPUT_HEALING:-}
network=${INPUT_DOCKER_NETWORK:-host}

fail() {
  echo "::error title=Proxy QA runner::$1"
  echo "exit-code=2" >>"${GITHUB_OUTPUT:-/dev/null}"
  exit 2
}

# Resolve a path into $resolved (relative paths are relative to the workspace) and
# require it to live inside the workspace, the only directory mounted into the container.
inside_workspace() {
  local label=$1 path=$2
  [[ $path == /* ]] || path="$workspace/$path"
  resolved=$(realpath -m -- "$path")
  [[ $resolved == "$workspace" || $resolved == "$workspace"/* ]] ||
    fail "$label must be inside the workspace ($workspace): $2"
}

inside_workspace config "$config"
config_path=$resolved
[[ -f $config_path ]] || fail "config file not found: $config"
inside_workspace output "$output"
output_path=$resolved
[[ $output_path != "$workspace" ]] || fail "output must be a subdirectory of the workspace, not the workspace itself."
args=(--config "$config_path" --output "$output_path")
if [[ -n $environment_name ]]; then
  args+=(--environment "$environment_name")
fi
if [[ -n $baselines ]]; then
  inside_workspace baselines "$baselines"
  baselines_path=$resolved
  [[ -f $baselines_path ]] || fail "baselines pack not found: $baselines"
  args+=(--baselines "$baselines_path")
fi
if [[ -n $healing ]]; then
  case $healing in
    off | warn | fail) args+=(--healing "$healing") ;;
    *) fail "healing must be off, warn or fail (got: $healing)." ;;
  esac
fi

# Pass proxy/provider settings through by name. Any variable in these families
# that is set and non-empty is forwarded, so new provider keys need no change here.
env_args=()
forwarded=()
while IFS= read -r name; do
  [[ -n ${!name:-} ]] || continue
  env_args+=(--env "$name")
  forwarded+=("$name")
  # Mask everything except plain routing fields (secrets.* are masked by GitHub
  # already; this also covers values supplied from vars.* or literals).
  case $name in
    QA_PROVIDER | *_HOST | *_PORT | *_SERVER | *_PRODUCT) ;;
    *)
      while IFS= read -r line; do
        [[ -n $line ]] && echo "::add-mask::$line"
      done <<<"${!name}"
      ;;
  esac
done < <(compgen -e | grep -E '^(QA_PROVIDER|QA_PROVIDER_[A-Z0-9_]+|DATAIMPULSE_PROXY_[A-Z0-9_]+|QA_PROXY_[A-Z0-9_]+)$' | sort || true)

if ((${#forwarded[@]})); then
  echo "Forwarding environment variables (names only): ${forwarded[*]}"
else
  echo "No proxy environment variables set: scenarios run over a direct connection."
fi

if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "::group::Pull $image"
  docker pull "$image" || {
    echo "::endgroup::"
    fail "could not pull $image. Check the image name and tag, or log in to the registry first."
  }
  echo "::endgroup::"
fi

# Run as the runner's user so reports are readable by later steps; mount the
# workspace at the same path so paths inside results.json are valid on the host.
set +e
docker run --rm --init --ipc=host \
  --network "$network" \
  --user "$(id -u):$(id -g)" --env HOME=/tmp \
  --volume "$workspace:$workspace" --workdir "$workspace" \
  "${env_args[@]}" \
  "$image" "${args[@]}"
code=$?
set -e

{
  echo "exit-code=$code"
  echo "results-json=$output_path/results.json"
  echo "output-dir=$output_path"
} >>"${GITHUB_OUTPUT:-/dev/null}"

case $code in
  0) echo "QA run passed. Reports: $output_path" ;;
  1) echo "::error title=Proxy QA runner::QA run failed (exit 1): at least one case failed. See results.html in the uploaded artifact." ;;
  2) echo "::error title=Proxy QA runner::Invalid configuration (exit 2): the manifest, flags or environment variables were rejected. See the log above." ;;
  130) echo "::error title=Proxy QA runner::QA run cancelled (exit 130)." ;;
  125) echo "::error title=Proxy QA runner::Docker could not start the runner container (exit 125)." ;;
  *) echo "::error title=Proxy QA runner::Runner exited with unexpected code $code." ;;
esac
# The calling action decides when to fail (after uploading reports).
exit 0
