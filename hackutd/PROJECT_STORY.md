# SentinelOS X: About the Project

## Inspiration

Security operations centers are drowning in alerts, and the people who respond to incidents have to juggle three questions at once: *what broke*, *what depends on it*, and *what is safe to change*. Most dashboards answer the first question well and leave the other two to memory and a group chat.

We wanted a command center that treats the **infrastructure itself as a model**. If the primary database goes down, the system should already know which services are affected, how far the damage can spread, and what each possible response would do before anyone clicks a button.

HackUTD 2026 gave us three directions that fit this idea:

- **NVIDIA Nemotron**: "Beyond a Chatbot" meant an agent that *acts* on a system, not one that only writes prose.
- **Winstead PC**: a cyber incident response dashboard for real responders.
- **SpacetimeDB**: a real-time application where the database is the authority, not a cache.

SentinelOS X is our attempt to combine all three.

## What it does

SentinelOS X is a real-time incident command center built on a digital twin of a 16-service infrastructure.

- **Digital twin**: an interactive graph of services with search, filters, zoom, and a blast-radius overlay.
- **Blast-radius engine**: a deterministic, cycle-safe computation that classifies each service as *root*, *direct*, *indirect*, or *potentially exposed*.
- **Incident workflow**: evidence, containment, and two-person recovery, all as real state transitions.
- **Simulation engine**: a scheduled reducer generates four synthetic scenarios and bounded six-metric telemetry.
- **Nemotron investigation agent**: a tool-calling agent that reads the twin, forms hypotheses, cites the evidence it actually retrieved, and proposes actions. **Every operational change requires human approval.**
- **Real-sensor extension**: a DHT11 temperature and humidity sensor on an Arduino UNO R4 WiFi feeds the same system. When real readings leave their limits, the command center opens a *real* incident whose evidence is the measured data.

## How we built it

### Architecture

```
Browser tabs ──┐                        ┌──────── SpacetimeDB (authoritative) ────────┐
(responders)   ├─ WebSocket ────────────┤ tables · reducers · propagation engine     │
Sensor bridge ─┤  subscriptions         │ roles · service authorization · audit log  │
Nemotron agent ┘                        └────────────────────────────────────────────┘
        └── HTTPS ──► NVIDIA API (OpenAI-compatible tool calling)
```

The design principle that shaped everything: **the database is the only source of truth, and every writer is an untrusted client until the server checks it.**

- **SpacetimeDB module (TypeScript)** owns the schema, the reducers, and the permission checks. The UI never recomputes authoritative impact; it only displays what the server recorded.
- **React 19 / Vite frontend** subscribes to tables and calls reducers. A success message appears only after the server commits.
- **Python agent service** (FastAPI) runs the Nemotron tool loop. It is its own SpacetimeDB identity and stays *pending* until an Incident Commander authorizes it.
- **Hardware bridge** (FastAPI) receives sensor readings. The Arduino is treated as an untrusted device: it can report readings, but it cannot set state or authorize anything.

### Blast radius

Given a root service $r$ and the dependency graph $G = (V, E)$, the engine assigns each service $v$ a level by shortest path on the reversed dependency edges:

$$
d(v) = \min_{p \in \mathcal{P}(v, r)} |p|, \qquad
\text{level}(v) =
\begin{cases}
\text{root} & d(v) = 0 \\
\text{direct} & d(v) = 1 \\
\text{indirect} & 2 \le d(v) \le k \\
\text{exposed} & \text{otherwise, reachable through a degraded neighbour}
\end{cases}
$$

A visited set makes the traversal cycle-safe, and overlapping paths are merged so each service appears once. We then derive a severity score from the fraction of affected services:

$$
S = \min\!\left(1,\ \frac{|\{v : \text{level}(v) \in \{\text{direct, indirect}\}\}|}{|V|}\right)
$$

The score is deterministic. The same graph and the same root always produce the same blast radius, which matters when people are making decisions under pressure.

### Agent loop

The Nemotron agent does not get free rein. Its loop works like this:

1. The model receives the incident and a fixed set of **read-only** tools (about ten of them).
2. It chooses a tool and arguments. The application validates the call against a schema, enforces a budget (for example, at most 12 tool calls and 30 model turns), and executes it.
3. Each finding must **cite evidence the agent really retrieved**. Claims with no matching evidence are rejected, and the model is asked to repair them. In our live run, two invalid reports were rejected and repaired this way.
4. Any proposed containment or recovery goes to a **human approval** step. Approvals are checked server-side against the responder's role.

The model's output is treated as untrusted input throughout, the same way we treat sensor data.

## What we learned

- **Make the database the authority.** When the UI, the agent, and the sensor bridge all write through the same role-checked reducers, a whole category of "the dashboard says X but the system says Y" bugs disappears.
- **Deterministic engines around a probabilistic model.** The LLM is good at choosing what to look at and how to explain it. It should not be the thing that computes impact. Keeping the blast-radius math in plain code made the agent's claims checkable.
- **Being honest about what is simulated.** We labelled every element of the real-sensor demo as *real*, *modeled*, or *synthetic*. The 16 services do not exist; the temperature readings do. Keeping that distinction visible in the product matters as much as the features do.
- **Evidence beats fluency.** Requiring citations turned out to be the most useful constraint we added to the agent.

## Challenges we faced

1. **Model availability is per account.** Several Nemotron models appeared in the public model list but returned `404 Not found for account` for our API key. Only some models were actually callable. We now probe each model before relying on it and document which ones were verified.
2. **Limited live testing.** Our automated tests use mocked HTTP and a scripted model double. We ran the live smoke test against the real API once, on one scenario, with one model. We say so in the README rather than presenting the scripted results as live behaviour.
3. **Hardware networking.** The Arduino UNO R4 WiFi only joins 2.4 GHz networks, and the demo network has to allow client-to-client traffic. Changing the hotspot name, password, or laptop IP means re-flashing the board. We kept credentials in a git-ignored header file and documented the setup steps.
4. **Schema evolution.** Phase 2 had to add tables to a live Phase 1 database without losing data. We used SpacetimeDB's migration planner to confirm that only additive changes were needed before publishing.
5. **Keeping the agent safe.** A model that can call tools and read incident text is exposed to prompt injection from that text. We separated read-only tools from state-changing ones, validated every tool call in application code, and never let the model approve its own actions.
6. **Scope.** We chose to build a credible, end-to-end demo over a large feature list. Several items, including a live infrastructure connector and a sandboxed agent deployment, are documented as designed but not yet implemented.

## What is next

- Run the live agent against the remaining incident scenarios and record the results.
- Replace the synthetic service graph with a connector to real infrastructure inventory.
- Add replay of past incidents so responders can compare their decisions against the engine's recommendations.
