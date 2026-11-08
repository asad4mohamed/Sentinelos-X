# SentinelOS X: real sensor demo

> **macOS:** use `./start_bridge.sh` (loads `.env`, builds the venv, prints the Mac IP) and follow `SentinelOS-X/docs/MACOS_RUNBOOK.md`. The PowerShell commands below are for Windows.

A real DHT11 temperature/humidity sensor on an Arduino UNO R4 WiFi feeds the command center. When its
real readings leave their limits, the **command center itself** opens a **real (non-simulated) incident**
whose evidence is the measured data, Nemotron investigates that evidence, and humans approve the response.

```
DHT11 -> Arduino -HTTP-> bridge (laptop :8765) -> SpacetimeDB module (detects, opens incident) <-WS-> UI
                           identity: Sentinel Gateway (service)            <-WS-> Nemotron agent (reads evidence + readings)
```

## What is real, modeled, and synthetic (say this honestly)

| Thing | Status |
|---|---|
| Temperature and humidity readings, the excursion, the "sensor went silent" event | **Real**, measured by hardware |
| Incident record, its evidence, AI investigation, roles, approvals, audit log | **Real** state in SpacetimeDB (`isSimulation = false`, evidence `synthetic = false`) |
| The 16 services (`primary-db`, `app-api`, ...) and their health | **Synthetic**: they do not exist |
| "Impact on dependent services" from a real heat event | **Modeled**: the twin assumes the primary DB is racked in the monitored closet (edge rationale says MODELED). A prediction, not a measurement |
| Approved "recovery" | **Simulated** restoration of the twin. The physical recovery is the readings returning to normal (recorded as a `readings_normalized` event) |
| Key `A` on the serial monitor | **Synthetic** fallback trigger for the old simulated incident. Not part of the real demo |

## Start everything

Laptop and Arduino must be on the same **2.4 GHz** network that does not isolate clients (phone hotspot). If the hotspot name,
password or the laptop's IPv4 changes, edit `SentinelArduino/arduino_secrets.h` (git-ignored) and re-flash.

```powershell
spacetime start                         # database
npm run publish:local                   # from SentinelOS-X/ (non-destructive; never publish:fresh)
npm run dev                             # UI at http://localhost:5173
npm run agent                           # needs services/.env: NVIDIA_API_KEY, NEMOTRON_MODEL=nvidia/nemotron-3-ultra-550b-a55b
# bridge (from hardware/):
Get-Content .env | % { $k,$v = $_ -split '=',2; Set-Item "Env:$k" $v }
.\.venv\Scripts\python.exe -m uvicorn bridge:app --host 0.0.0.0 --port 8765
```

One-time setup on a fresh database: register a tab (first user is Incident Commander); create two identities with
`POST /v1/identity` (analyst bridge, gateway); `register_responder` for the analyst and set its role in Settings;
`announce_service("Sentinel Gateway","hardware_gateway")` and authorize it in Settings -> Services; authorize "Nemotron Investigator".
The gateway registers the sensor node itself on its first reading.

## Live script (about 2 minutes)

| Step | Action | What you see |
|---|---|---|
| 0 | Nothing | Overview shows the **Physical sensors** card: live temperature/humidity (about 23 °C / 41%), "real measurements". Arduino LED matrix: checkmark |
| 1 | **Breathe on the sensor** (humidity above 70%, fastest) or warm it with your hand / a hair dryer (temp 30 °C, or +3 °C within 2 min) | After 2 consecutive breaching readings (about 8 s) a **Real event** incident opens. LED matrix: X |
| 2 | Open the incident | Evidence is labeled **measured** with the actual values, baseline and limit. Timeline shows the real excursion. Twin shows the closet asset degraded and a *modeled* cascade |
| 3 | AI Investigator | Nemotron calls `get_incident`, `get_evidence`, `get_sensor_readings`, ... and reports findings, calling impact "modeled" and not inventing a cause. Hourglass on the LED matrix |
| 4 | Analyst tab: **Accept**; a *different* Incident Commander: **Approve** | Two-person rule. Twin recovers (simulated). LED matrix: checkmark |
| 5 | Let the room cool | `readings_normalized` event appears in the timeline (measured recovery) |
| 6 (optional) | **Unplug the Arduino** or cut its Wi-Fi | After 30 s a real **"monitoring lost"** incident opens. Plug back in: `sensor_back_online` event |

An open real incident blocks "Reset demo environment" on purpose. An Incident Commander resolves it from the incident page.

## OLED status display (optional)

A 128x64 I2C OLED (SSD1306, address 0x3C) shows the live DHT11 reading (refreshed every 2 s) and what the command center is doing.
Wiring: GND -> GND, VCC -> 5V, SCL -> A5, SDA -> A4. Needs the **U8g2** Arduino library. Display-only: it never sends anything or changes the data path.

| Screen title | When | Guidance lines |
|---|---|---|
| NORMAL | bridge `HEALTHY`, readings below the early-warning levels | All readings normal / Monitoring live |
| WARNING | still `HEALTHY` but temp >= 27 C or humidity >= 60% (local early warning, below the real limits) | Temperature/Humidity rising / Ease off the sensor |
| ALERT (blinks) | bridge `ALERT` | which limit is over / Next: AI investigates |
| INVESTIGATING | bridge `INVESTIGATING` | AI analysing evidence / Next: analyst ACCEPTS |
| APPROVAL NEEDED (blinks) | bridge `AWAITING_APPROVAL` | Analyst: ACCEPT, then Commander: APPROVE |
| RESOLVED | bridge `RECOVERED` | Response approved / Readings settling... |
| NO WIFI / NO BRIDGE | link lost | Local readings keep updating |
| SENSOR ERROR | DHT11 read failing | Check wiring (pin 2) |

When the bridge returns to `HEALTHY` and readings are back under the warning levels, the screen returns to NORMAL. The 27 C / 60% warning levels
and the 30 C / 70% limits drawn from `LIMIT_*` in the sketch are display-only copies; the real limits live in `hardware/.env`.
Confirmed by a person looking at the screen: NORMAL-layout test text and the blinking ALERT screen (bridge `ALERT`). Not yet confirmed: WARNING, INVESTIGATING, APPROVAL NEEDED, RESOLVED, NO WIFI/NO BRIDGE, SENSOR ERROR.

## Detection rules (in the SpacetimeDB module, `spacetime/src/sensor.ts`)

Temperature >= limit (30 °C), or humidity >= limit (70%), or temperature up >= 3 °C within 120 s. Two consecutive breaching readings are required
(debounce for sensor glitches). Readings outside the physical range are rejected. A value that cannot be computed is `unknown`, never 0.
Limits are set by `SENSOR_TEMP_LIMIT_C`, `SENSOR_HUMIDITY_LIMIT_PCT` in `hardware/.env`.

## Trust model

The Arduino is untrusted: it can only report readings. The bridge forwards them under its own `hardware_gateway` service identity, which an
Incident Commander must authorize. Detection, incident creation and every permission check run inside SpacetimeDB. The gateway cannot request
or approve recovery. The synthetic `A` path still uses a separate analyst identity.

## Verification status

Automated (run in this session): module 69 tests, agent 24, frontend 31, bridge 41, plus the repository's `npm run check` (typecheck, tests, builds).
Live, on real hardware: readings flowed Arduino -> bridge -> SpacetimeDB; the silent-sensor watchdog opened a real incident when the Arduino lost Wi-Fi
(laptop left the hotspot), and Nemotron investigated it with the new tools.

Also verified live (2026-11-07 evening): a real humidity excursion (breath, 42% to 81%) opened real incident INC-3 with measured evidence; Nemotron
investigated it (10 tool calls, 3 findings, 1 recommendation); an analyst accepted it, a different Incident Commander approved it, all assets returned to
healthy, the bridge reported RECOVERED, and a person confirmed the checkmark on the Arduino LED matrix. Humidity then fell back to about 44%.

**Not yet verified live:** the LED matrix X (ALERT) and hourglass pictures (only the final checkmark was reported by a person); a temperature-triggered
excursion (only humidity was exercised); the "rapid rise" rule on real hardware (unit-tested only).

**Caveat on AI wording:** on INC-3 one finding stated the 8-asset blast radius as fact; only another finding called it "predicted". The prompt asks for
"modeled", so say "modeled" yourself when presenting.

## Known limits

- DHT11 is slow and coarse (about +/-2 °C, +/-5% RH, 1 reading per second maximum). Humidity from breath is the most reliable demo trigger.
- Plain HTTP and static tokens on a local network: demo-grade, not a security control. Do not claim it satisfies Winstead's isolation requirement by itself.
- Wi-Fi and laptop IP are baked into the firmware. A venue network with client isolation breaks it. Fallback: the bridge reads the board over USB.
- Bridge restarts forget the tracked incident (the module state is unaffected).
- Changes to `SentinelOS-X` are on branch `hardware-sensor` and are **not committed**; they touch the module (new tables, service kind, three reducers, one guard in the telemetry tick), the agent (two tools, prompt, last-turn summary), and the UI. Your teammate should review before merging.
- Two NVIDIA agents exist (`agent/` Python, `SentinelOS-X/services` Node); only the Node one is wired to this flow.
- `nemotron-3-super-120b-a12b` returned 404 for this account. The key that was exposed earlier should be rotated.

## Final pass (HackUTD submission)

- **Firmware unchanged — no re-flash needed.** The board POSTs every 4 s; the bridge's new flood guard only rejects readings closer than `SENSOR_MIN_INTERVAL_S` (0.5 s).
- New: `hardware/.env.example` documents every variable with placeholders. Copy it to `.env` only if your `.env` is lost; your existing `.env` keeps working.
- Bridge hardening: `Content-Length` checked before reading the body (≤ 1 KiB → 413), reading flood guard (429). Tests: 44 passing (`python -m pytest -q`).
- Pre-demo check from `SentinelOS-X/`: `npm run preflight -- --hardware` verifies the bridge is up, readings are fresh (< 15 s) and the gateway is authorized.
- Rotate `SENTINEL_DEVICE_TOKEN` / `SENTINEL_ADMIN_TOKEN` and the Wi-Fi password after the event (they were in the shared project archive). If you rotate the device token, update `BRIDGE_TOKEN` in `arduino_secrets.h` and re-flash.
- If the hardware is not working at demo time, skip the sensor scene; every other scene uses synthetic scenarios and needs no hardware. Do not feed fake readings to the bridge — they would be recorded as real.
