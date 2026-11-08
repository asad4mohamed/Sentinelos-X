# macOS runbook — start, verify, flash, roll back

Paths below assume `~/Downloads/sentinelOS_final/hackutd`. Adjust if yours differs.

## 0. One-time setup

```bash
cd ~/Downloads/sentinelOS_final/hackutd
chmod +x mac-doctor.sh setup-nemotron-mac.sh hardware/start_bridge.sh
./mac-doctor.sh               # read-only: Node, npm, SpacetimeDB CLI, Python, deps, .env presence, ports, Mac IP
```
Fix each FAIL with the command it prints. Typical ones:

```bash
brew install node@22 && brew link --overwrite --force node@22     # Node 22.12+ (Vite 7 requirement)
curl -sSf https://install.spacetimedb.com | sh                     # SpacetimeDB CLI 2.x, then open a new terminal
cd SentinelOS-X && npm run install:all                             # always install ON the Mac (Windows node_modules won't run)
```
Python: the bridge works with the `python3` that ships with macOS (3.9) — tested on 3.9 and 3.13.

NVIDIA key (hidden prompt, never echoed, writes only `SentinelOS-X/services/.env`, then runs a real check):
```bash
./setup-nemotron-mac.sh
```

## 1. Credentials (names only — never paste values into chat or commits)

| Variable | File | Used by |
|---|---|---|
| `NVIDIA_API_KEY`, `NEMOTRON_MODEL`, `NVIDIA_BASE_URL` | `SentinelOS-X/services/.env` | Nemotron agent |
| `SPACETIMEDB_HOST`, `SPACETIMEDB_DB_NAME` | `SentinelOS-X/services/.env` | agent, telemetry |
| `SENTINEL_DEVICE_TOKEN`, `SENTINEL_ADMIN_TOKEN` | `hardware/.env` | bridge (device must send the same device token) |
| `SPACETIMEDB_URL`, `SPACETIMEDB_DB`, `SPACETIMEDB_GATEWAY_TOKEN` | `hardware/.env` | bridge → SpacetimeDB |
| `WIFI_SSID`, `WIFI_PASS`, `BRIDGE_HOST`, `BRIDGE_PORT`, `BRIDGE_TOKEN` | `hardware/SentinelArduino/arduino_secrets.h` | firmware |

Templates: `services/.env.example`, `hardware/.env.example`, `hardware/SentinelArduino/arduino_secrets.template.h`. All real files are git-ignored. Do **not** overwrite an existing `.env`.

## 2. Start the stack (one terminal each; keep all running)

```bash
# T1 — database (leave running)
spacetime start
```
```bash
# T2 — module + UI
cd ~/Downloads/sentinelOS_final/hackutd/SentinelOS-X
npm run publish:local      # non-destructive upgrade. NEVER publish:fresh / --delete-data
npm run dev                # http://localhost:5173
```
```bash
# T3 — Nemotron agent
cd ~/Downloads/sentinelOS_final/hackutd/SentinelOS-X
npm --prefix services run agent:check   # one real NVIDIA call: key + model
npm run agent
```
```bash
# T4 — hardware bridge (optional)
cd ~/Downloads/sentinelOS_final/hackutd/hardware
./start_bridge.sh          # loads .env silently, creates .venv on first run, prints the laptop IP
```
`npm run telemetry` (optional) is an external synthetic-telemetry generator; the built-in simulation engine already produces telemetry, so it is not needed for the demo.

Then in the browser (two windows): register Ada (becomes Incident Commander) and Ben (Settings → Security Analyst). Ada: Settings → Services → **Authorize** "Nemotron Investigator" and "Sentinel Gateway".

```bash
# T2 again
npm run preflight -- --hardware     # drop --hardware if not showing the sensor
```
Repeat until it prints **Demo-ready**.

## 3. Arduino (UNO R4 WiFi) — upload the existing firmware

1. Arduino IDE → **Tools → Board → Arduino UNO R4 Boards → Arduino UNO R4 WiFi** (install "Arduino UNO R4 Boards" in Boards Manager if missing).
2. Plug in USB-C. **Tools → Port** → the entry like `/dev/cu.usbmodemXXXX (Arduino UNO R4 WiFi)`.
3. **Library Manager**: install **DHT sensor library** (Adafruit, accept "Adafruit Unified Sensor"), **U8g2** (olikraus). `WiFiS3` and `Arduino_LED_Matrix` come with the board package.
4. Copy `hardware/SentinelArduino/arduino_secrets.template.h` → `arduino_secrets.h` (only if it does not exist). Set Wi-Fi (2.4 GHz), `BRIDGE_HOST` = the IP `start_bridge.sh` printed, `BRIDGE_PORT` 8765, `BRIDGE_TOKEN` = `SENTINEL_DEVICE_TOKEN`.
5. Open `hardware/SentinelArduino/SentinelArduino.ino` → **Upload**. The firmware is unchanged in this sprint; skip re-flashing if the board already runs it and the IP is the same.
6. **Tools → Serial Monitor**, 115200 baud: expect `SentinelOS X firmware boot. Reading a REAL DHT11 on pin 2…`.

Wiring (verified against the sketch): DHT11 data → **D2**; OLED SDA → **A4**, SCL → **A5** (the UNO R4 WiFi's `Wire` bus; the Qwiic connector is a different bus and is not used); power from 5V/3.3V/GND. **Check the voltage printed on your OLED and DHT11 modules** (most accept 3.3–5 V).

## 4. Hardware verification (you must observe these — they are not verified by automated tests)

| Step | Do | Expect |
|---|---|---|
| 1 | Power on, bridge running | OLED **NORMAL** with °C / %; LED matrix **✓**; UI top bar *Sensor gateway: online*; Overview → Physical sensors shows readings |
| 2 | Breathe on the DHT11 (humidity > 70 %) for ~10 s | **Real event** incident in the UI; LED matrix **X**; OLED **ALERT** |
| 3 | AI Investigator → run on that incident | LED matrix hourglass; OLED **INVESTIGATING** |
| 4 | Ben requests recovery, Ada approves (Incident Command) | OLED **RESOLVED**; LED matrix back to **✓** once readings are normal |
| 5 | Stop `start_bridge.sh` | OLED **NO BRIDGE**, LED matrix dashed frame; UI gateway *offline* after ~20 s |
| 6 | Restart the bridge | readings resume within one poll |
| 7 | Unplug the DHT11 data wire briefly | OLED **SENSOR ERROR — Check wiring (pin 2)**; after `SENSOR_SILENT_AFTER_S` the module records a sensor fault |

Use only breath or a warm hand — no heat guns or open flames.

## 4b. Network: when the Arduino can't reach the Mac

The Arduino must reach the Mac's IP on port 8765. Campus/guest Wi-Fi (e.g. UTD guest, eduroam) usually blocks device-to-device traffic or is 5 GHz-only — the UNO R4 WiFi only supports **2.4 GHz**.

Reliable fallback — phone hotspot:
1. iPhone: Settings → Personal Hotspot → turn on **Maximize Compatibility** (forces 2.4 GHz). Android: set the hotspot band to 2.4 GHz.
2. Connect the **Mac** to the hotspot. Run `./start_bridge.sh`; it prints the Mac's current IP.
3. Put the hotspot name/password and that IP (`BRIDGE_HOST`) in `arduino_secrets.h` → Upload.
4. From the Mac: `curl http://localhost:8765/health` should return `"ok":true`.
5. If macOS asks "Allow incoming network connections" for Python, click **Allow** (System Settings → Network → Firewall).

The IP changes whenever the Mac changes networks: re-check it with `./start_bridge.sh` (or `ipconfig getifaddr en0`) and re-flash if it differs. Never commit `arduino_secrets.h`.

If the network can't be fixed in time: skip the sensor scene. Everything else runs without hardware.

## 5. Rollback (keeps the database)

Code only — the database is untouched by any of these:

```bash
cd ~/Downloads/sentinelOS_final/hackutd/SentinelOS-X
git log --oneline | head            # find the commit to return to
git tag                             # checkpoint-before-sprint2 = state before this sprint
git switch -c rollback checkpoint-before-sprint2
npm run dev                         # UI from the older code
```
The schema did not change in this sprint, so older UI code works against the current database without republishing. Do **not** republish an older module over a database that has newer tables unless you know the migration is additive; never use `--delete-data`.
