#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT/SentinelOS-X/services/.env"
EXAMPLE="$ROOT/SentinelOS-X/services/.env.example"
if [[ ! -f "$ENV_FILE" ]]; then cp "$EXAMPLE" "$ENV_FILE"; chmod 600 "$ENV_FILE"; fi
printf 'Enter your NEW NVIDIA API key (hidden; do not reuse the key shared in chat): '
IFS= read -r -s API_KEY
printf '\n'
# Strip spaces, tabs and stray carriage returns that sneak in when pasting.
API_KEY="$(printf '%s' "$API_KEY" | tr -d ' \t\r\n')"
if [[ -z "$API_KEY" ]]; then echo 'No key entered. Nothing changed.'; exit 1; fi
if [[ "$API_KEY" != nvapi-* ]]; then echo 'Warning: NVIDIA keys normally start with "nvapi-". Saving anyway.'; fi
if [[ ! -d "$ROOT/SentinelOS-X/services/node_modules" ]]; then
  echo 'Installing dependencies first (npm run install:all)...'
  (cd "$ROOT/SentinelOS-X" && npm run install:all)
fi
export API_KEY ENV_FILE
python3 - <<'PYINNER'
import os, pathlib
p=pathlib.Path(os.environ['ENV_FILE'])
lines=p.read_text().splitlines()
settings={'NVIDIA_API_KEY':os.environ['API_KEY'], 'NVIDIA_BASE_URL':'https://integrate.api.nvidia.com/v1','NEMOTRON_MODEL':'nvidia/nemotron-3-ultra-550b-a55b','NEMOTRON_THINKING':'false'}
seen=set(); output=[]
for line in lines:
    if '=' in line and not line.lstrip().startswith('#'):
        k=line.split('=',1)[0].strip()
        if k in settings:
            if k not in seen: output.append(k+'='+settings[k]); seen.add(k)
            continue
    output.append(line)
for k,v in settings.items():
    if k not in seen: output.append(k+'='+v)
p.write_text('\n'.join(output)+'\n'); p.chmod(0o600)
PYINNER
unset API_KEY
echo 'NVIDIA configuration saved locally. Running agent check...'
cd "$ROOT/SentinelOS-X"
npm --prefix services run agent:check
