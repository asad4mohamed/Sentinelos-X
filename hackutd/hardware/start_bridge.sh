#!/usr/bin/env bash
# macOS / Linux launcher for the SentinelOS X hardware bridge.
# Loads hardware/.env (never printed), creates the venv on first run, starts uvicorn on :8765.
#   cd hardware && ./start_bridge.sh
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "hardware/.env not found. Copy .env.example to .env and fill it in (values are never printed)." >&2
  exit 1
fi

# Pick the newest Python available (macOS ships 3.9 as python3; Homebrew/python.org may add newer ones).
PY="${PYTHON:-}"   # override: PYTHON=/path/to/python3 ./start_bridge.sh
[[ -n "$PY" ]] || for c in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
  done
[[ -n "$PY" ]] || { echo "python3 not found. Install it: xcode-select --install  (or brew install python)" >&2; exit 1; }
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo "Python 3.9+ required (found $("$PY" -V 2>&1))." >&2; exit 1; }

# (Re)create the venv if missing, copied from Windows (no bin/), or missing packages.
if [[ ! -x .venv/bin/python ]] || ! .venv/bin/python -c 'import fastapi, uvicorn, httpx' >/dev/null 2>&1; then
  echo "Setting up hardware/.venv with $("$PY" -V 2>&1) (first run only)..."
  rm -rf .venv
  "$PY" -m venv .venv
  .venv/bin/python -m pip install -q --upgrade pip >/dev/null 2>&1 || true
  .venv/bin/python -m pip install -q -r requirements.txt
fi

# Export KEY=value lines from .env without echoing them. Comments and blank lines are skipped.
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
  key="${line%%=*}"; val="${line#*=}"
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
  val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
  export "$key=$val"
done < .env

for v in SENTINEL_DEVICE_TOKEN SENTINEL_ADMIN_TOKEN; do
  [[ -n "${!v:-}" ]] || { echo "$v is empty in hardware/.env" >&2; exit 1; }
done
[[ -n "${SPACETIMEDB_GATEWAY_TOKEN:-}" ]] || echo "Note: SPACETIMEDB_GATEWAY_TOKEN is empty — bridge runs standalone (readings are NOT forwarded to SpacetimeDB)."

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)
echo "Bridge starting on port 8765."
echo "  Laptop IP right now: ${IP:-unknown}  -> must equal BRIDGE_HOST in arduino_secrets.h (re-flash if it changed)."
echo "  Health check from this Mac: curl http://localhost:8765/health"
exec .venv/bin/python -m uvicorn bridge:app --host 0.0.0.0 --port 8765
