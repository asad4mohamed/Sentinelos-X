# Demo recovery procedures

Run `npm run preflight` first — each FAIL line prints its fix. None of these steps delete data.

| Symptom | Fix |
|---|---|
| Red *Connection to SpacetimeDB lost* banner | Terminal 1 died. Run `spacetime start`, then click **Retry now**. Data persists; identities survive a refresh. |
| UI loads but tables never fill ("Still waiting for live data") | Module not published or outdated: `npm run publish:local` (additive). |
| Decision Lab says *tables missing* in preflight / reducer not found | Same: `npm run publish:local`. Only run `npm run generate` if you changed `spacetime/src/index.ts`. |
| "Simulation already active (incident #n)" when launching | Recover + resolve it, or Ada → *Settings → Reset demo environment*. |
| Reset refused: "non-simulated incident is active" | A real sensor incident is open by design. Resolve it from its incident page (recover first). |
| "Unauthorized: register as a responder first" | That tab lost its identity (new tab). Register again; use *Settings* to claim a role. |
| Two-person rule blocks approval | Expected: approve from the **other** window. |
| "Stale proposal" | The incident changed (e.g. containment applied) after the preview. The lab already shows the fresh preview — propose again. |
| Nemotron agent *awaiting authorization* | Ada → *Settings → Services → Authorize*. |
| Nemotron agent *not connected* / explanation stuck at *requested* | Start `npm run agent`. Or cancel the request — the deterministic comparison does not need AI. Say: "the model is unavailable; the analysis is deterministic". |
| Agent log: `404 (model not found or not enabled…)` | Change `NEMOTRON_MODEL` in `services/.env` to a model `agent:check` lists; restart the agent. |
| Agent log: `429 (rate limited after retries)` | Wait ~30 s and request again; the client already retried with backoff. |
| Agent log: `401/403 (API key rejected)` | Key revoked/rotated. Put the new key in `services/.env`, restart the agent. |
| Sensor card shows no readings | Bridge not running, Arduino off-network, or laptop IP changed. Skip scene 6; see `hardware/HARDWARE_DEMO.md`. |
| Bridge `/health` shows `last_error` | Authorize "Sentinel Gateway" in *Settings → Services*; check `SPACETIMEDB_GATEWAY_TOKEN`. |
| Bridge returns 429 | Readings arriving faster than `SENSOR_MIN_INTERVAL_S` (default 0.5 s): firmware loop too fast or a replay. |

**Never** run `npm run publish:fresh` or `spacetime publish --delete-data` before or during the demo: that erases the database.
