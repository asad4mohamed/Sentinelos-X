# Judge demo (2–3 minutes)

## Before judges arrive (10 minutes)

```bash
# Terminal 1 — database (keep running)
spacetime start

# Terminal 2 — from SentinelOS-X/
npm run publish:local        # non-destructive upgrade; adds Decision Lab tables, keeps data. NEVER publish:fresh
npm run dev                  # http://localhost:5173

# Terminal 3 — Nemotron agent (needs services/.env with NVIDIA_API_KEY)
npm --prefix services run agent:check   # one real API call: verifies key + model
npm run agent

# Optional terminal 4 — hardware bridge (from hardware/, see hardware/HARDWARE_DEMO.md)

# Then, with the browser windows below registered:
npm run preflight            # add -- --hardware if the sensor must be live
```

Open **two browser windows side by side** (a normal and a private window, or two tabs — each tab is its own identity).

- **Left = Ada**: register first → Incident Commander. In *Settings → Services*, **Authorize** "Nemotron Investigator" (and "Sentinel Gateway" if hardware is used).
- **Right = Ben**: register → *Settings → Dev-only role self-service → Security Analyst*.

Run `npm run preflight` until it says **Demo-ready**. If a previous run left a database outage open, Ada uses *Settings → Reset demo environment* (closes simulations with a timeline entry; deletes nothing).

## Script (3 minutes)

| Time | Scene | Action | What to say |
|---|---|---|---|
| 0:00 | **Problem** | Overview. | "Alerts tell you *what* broke, not *what else breaks* or *what to do*. SentinelOS X models dependencies, investigates with Nemotron, compares responses, and keeps humans in control." |
| 0:15 | **Live infrastructure** | Digital Twin. Top bar: *Live · SpacetimeDB*, agent online, sensor gateway online. | "16 modeled services, 21 typed dependencies, all live SpacetimeDB subscriptions. The twin is a simulation, and it says so." |
| 0:30 | **Detection** | Ben: **Launch Simulated Incident → Database outage**. (Optional: breathe on the DHT11 → a **Real event** opens; LED matrix shows **X**.) | "One reducer transaction computed the blast radius. A physical sensor can open a *real* incident too — the reading is measured, its effect on the twin is modeled." |
| 0:50 | **Attack path** | Digital Twin → pick *INC-n* in *Blast radius* → click **Customer Portal**. Read *Why is this service affected?* | "Primary Database is the confirmed root. Customer Portal is *modeled* impact: here's the exact dependency path. We never call a prediction an observation." |
| 1:15 | **AI investigation** | AI Investigator → **Run AI investigation**. Show tool steps, findings citing evidence, recommendation awaiting approval. | "Nemotron chooses read-only tools; findings must cite evidence it actually retrieved; it cannot approve or execute anything." If NVIDIA is down: "The panel switched to a *labeled* rules-based analysis — not AI pretending." |
| 1:45 | **Decision Lab** | **Compare responses**. Point at the ★ Engine pick banner, the hypothetical failover, the before/after graph. **Explain with Nemotron**. | "Every option is a hypothetical projection. Failover looks perfect but there's no standby — the lab says so and won't recommend it." |
| 2:15 | **Approval** | Ben: **Propose This Response** → Ada **Adopt plan** → Ada **Request recovery** → Ben approves in Incident Command. | "Two different people, enforced by the server — not by a disabled button." |
| 2:40 | **Recovery & record** | Twin turns blue → green in both windows. Incidents → **Report .md / Printable**. (Sensor: LED matrix back to ✓.) | "Recovery, audit trail and a report that labels what was measured, synthetic, modeled, and AI-generated." |

**Hardware disconnected?** Skip scene 6 — the rest needs no hardware. The safe fallback is the synthetic **Database outage** scenario, already labeled *Simulation*. We do not inject fake sensor readings.

## Honesty talking points

- Infrastructure, evidence and telemetry are synthetic, except the DHT11 readings (real) and incidents opened from them (`isSimulation = false`). Dependent-service impact from a real reading is **modeled**.
- Decision Lab predictions are about the model. Hypothetical strategies are labeled and cannot be executed.
- AI text is labeled AI-generated and is never the source of a result.
- Roles are enforced server-side, but identities are anonymous tokens (dev mode); role self-service is on for the demo.
- Automated tests use mocked NVIDIA responses. Live NVIDIA runs are recorded separately (see `FINAL_HACKUTD_READINESS.md`).
