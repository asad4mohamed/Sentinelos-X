#!/usr/bin/env bash
# Run the Nemotron investigator inside an NVIDIA OpenShell sandbox.
# Prereqs: OpenShell installed (macOS Apple Silicon/Linux + Docker), `spacetime start`
# running on this machine, module published, NVIDIA_API_KEY exported in this shell.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${NVIDIA_API_KEY:?export NVIDIA_API_KEY first (https://build.nvidia.com)}"
NAME="${SANDBOX_NAME:-sentinel-agent}"
DB="${SPACETIMEDB_DB_NAME:-sentinelos-x}"
MODEL="${NEMOTRON_MODEL:-nvidia/nemotron-3-super-120b-a12b}"

npm run build >/dev/null
mkdir -p .openshell-upload/app && cp dist/agent.js dist/agent.js.map .openshell-upload/app/

# 1. NVIDIA provider: binds the key to integrate.api.nvidia.com, for node only.
openshell provider profile lint -f openshell/nvidia-node-provider.yaml
openshell provider profile import -f openshell/nvidia-node-provider.yaml || true   # already imported is fine
openshell provider get nvidia-sentinel >/dev/null 2>&1 || \
  openshell provider create --name nvidia-sentinel --type nvidia-node --credential NVIDIA_API_KEY

# 2. Sandbox from the official Node 22 image with the least-privilege policy.
openshell sandbox create --name "$NAME" \
  --from node:22-bookworm-slim \
  --policy openshell/policy.yaml \
  --provider nvidia-sentinel \
  --upload .openshell-upload:/sandbox \
  --env SPACETIMEDB_HOST=ws://host.openshell.internal:3000 \
  --env SPACETIMEDB_DB_NAME="$DB" \
  --env NEMOTRON_MODEL="$MODEL" \
  --keep

# 3. Start the agent (uploads cannot be combined with a trailing command).
openshell sandbox exec -n "$NAME" --no-tty --timeout 0 --workdir /sandbox -- node /sandbox/app/agent.js
