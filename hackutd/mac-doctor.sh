#!/usr/bin/env bash
# SentinelOS X — macOS prerequisite check. READ-ONLY: installs nothing, changes nothing,
# never prints secret values.   Usage:  cd hackutd && ./mac-doctor.sh
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; fail=0; warn=0
ok()   { printf 'PASS  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf 'FAIL  %s\n      -> %s\n' "$1" "$2"; fail=$((fail+1)); }
note() { printf 'WARN  %s\n      -> %s\n' "$1" "$2"; warn=$((warn+1)); }

# Node: Vite 7 needs 20.19+ or 22.12+; process.loadEnvFile needs 20.12+.
if command -v node >/dev/null 2>&1; then
  v=$(node -p 'process.versions.node'); maj=${v%%.*}; rest=${v#*.}; min=${rest%%.*}
  if (( maj >= 23 || (maj == 22 && min >= 12) || (maj == 20 && min >= 19) )); then ok "Node $v"
  else bad "Node $v is too old" "brew install node@22 && brew link --overwrite --force node@22   (or use nvm: nvm install 22)"; fi
else bad "Node not installed" "brew install node@22"; fi

command -v npm >/dev/null 2>&1 && ok "npm $(npm -v)" || bad "npm missing" "comes with Node"

if command -v spacetime >/dev/null 2>&1; then
  sv=$(spacetime --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)
  [[ "${sv%%.*}" == "2" ]] && ok "SpacetimeDB CLI $sv" || note "SpacetimeDB CLI ${sv:-unknown}" "The module targets SpacetimeDB 2.x (tested with 2.14.1)."
else bad "SpacetimeDB CLI missing" "curl -sSf https://install.spacetimedb.com | sh   then open a new terminal"; fi

if command -v python3 >/dev/null 2>&1; then
  pv=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')
  python3 -c 'import sys;sys.exit(0 if sys.version_info>=(3,9) else 1)' && ok "Python $pv (hardware bridge needs 3.9+)" || bad "Python $pv too old" "xcode-select --install  or  brew install python"
else note "python3 missing" "Only needed for the hardware bridge: xcode-select --install"; fi

[[ -d "$ROOT/SentinelOS-X/frontend/node_modules" && -d "$ROOT/SentinelOS-X/services/node_modules" && -d "$ROOT/SentinelOS-X/spacetime/node_modules" ]] \
  && ok "npm dependencies installed" || bad "npm dependencies missing" "cd SentinelOS-X && npm run install:all"
# node_modules copied from Windows contain the wrong native binaries (esbuild/rollup).
if [[ -d "$ROOT/SentinelOS-X/frontend/node_modules/@rollup" ]] && ls "$ROOT/SentinelOS-X/frontend/node_modules/@rollup" | grep -q win32; then
  bad "node_modules were installed on Windows" "cd SentinelOS-X && rm -rf spacetime/node_modules frontend/node_modules services/node_modules && npm run install:all"
fi

envkey() { [[ -f "$1" ]] && grep -Eq "^$2=.+" "$1"; }
if [[ -f "$ROOT/SentinelOS-X/services/.env" ]]; then
  envkey "$ROOT/SentinelOS-X/services/.env" NVIDIA_API_KEY && ok "services/.env has NVIDIA_API_KEY (value hidden)" || bad "NVIDIA_API_KEY empty" "./setup-nemotron-mac.sh"
else bad "SentinelOS-X/services/.env missing" "./setup-nemotron-mac.sh   (creates it from .env.example)"; fi
if [[ -f "$ROOT/hardware/.env" ]]; then
  envkey "$ROOT/hardware/.env" SENTINEL_DEVICE_TOKEN && ok "hardware/.env has SENTINEL_DEVICE_TOKEN (value hidden)" || note "hardware/.env incomplete" "see hardware/.env.example (hardware is optional)"
  envkey "$ROOT/hardware/.env" SPACETIMEDB_GATEWAY_TOKEN || note "SPACETIMEDB_GATEWAY_TOKEN empty" "bridge will run standalone; readings won't reach the dashboard"
else note "hardware/.env missing" "optional — cp hardware/.env.example hardware/.env"; fi

for port in 3000 5173 8765; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'INFO  port %s in use by: %s\n' "$port" "$(lsof -nP -iTCP:$port -sTCP:LISTEN | awk 'NR==2{print $1" (pid "$2")"}')"
  else printf 'INFO  port %s free\n' "$port"; fi
done

ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
[[ -n "$ip" ]] && printf 'INFO  Mac IP for BRIDGE_HOST: %s  (changes when you switch Wi-Fi)\n' "$ip" || note "no Wi-Fi IP found" "connect to Wi-Fi (needed only for the Arduino)"

printf '\n%d PASS · %d FAIL · %d WARN\n' "$pass" "$fail" "$warn"
(( fail == 0 )) && echo "Prerequisites OK. Next: see SentinelOS-X/docs/MACOS_RUNBOOK.md" || exit 1
