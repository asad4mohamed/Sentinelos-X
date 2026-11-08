// SentinelOS X — pre-demo validation. READ-ONLY: it never publishes, deletes,
// resets or writes application data. It only reads public tables over the
// SpacetimeDB HTTP API (with a throwaway anonymous identity) and probes local URLs.
//
//   npm run preflight                 (from SentinelOS-X/)
//   npm run preflight -- --hardware   (treat the sensor bridge as required)
//
// Exit code 1 if any check FAILs. SKIPPED is never silently counted as PASS.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, DEMO_ASSETS } from '../../../spacetime/src/seed';
import { evaluateAll } from '../../../spacetime/src/decisionLab';

type Status = 'PASS' | 'FAIL' | 'SKIPPED';
const results: { status: Status; name: string; detail: string; fix?: string }[] = [];
const add = (status: Status, name: string, detail: string, fix?: string) => results.push({ status, name, detail, fix });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // services/dist → services
const REPO = join(ROOT, '..');
const args = new Set(process.argv.slice(2));
const requireHardware = args.has('--hardware');

function envFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}
const svcEnv = { ...envFile(join(ROOT, '.env')), ...process.env } as Record<string, string | undefined>;
const wsHost = svcEnv.SPACETIMEDB_HOST || 'ws://localhost:3000';
const HTTP = wsHost.replace(/^ws/, 'http').replace(/\/$/, '');
const DB = svcEnv.SPACETIMEDB_DB_NAME || 'sentinelos-x';
const FRONTEND = process.env.PREFLIGHT_FRONTEND_URL || 'http://localhost:5173';
const BRIDGE = process.env.PREFLIGHT_BRIDGE_URL || 'http://localhost:8765';

async function get(url: string, ms = 3000): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(ms) });
  } catch {
    return null;
  }
}

let token = '';
async function sql(query: string): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${HTTP}/v1/database/${DB}/sql`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: query, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const data = (await r.json()) as unknown;
  const res = (Array.isArray(data) ? data[0] : data) as { schema: { elements: { name: { some?: string } | string }[] }; rows: unknown[][] };
  const cols = res.schema.elements.map(e => (typeof e.name === 'string' ? e.name : (e.name.some ?? '')));
  return res.rows.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}
const optSome = (v: unknown) => (v && typeof v === 'object' && 'some' in (v as object) ? (v as { some: unknown }).some : undefined);

async function main() {
  // 1. SpacetimeDB reachable
  const ping = await get(`${HTTP}/v1/ping`);
  if (!ping || !ping.ok) {
    add('FAIL', 'SpacetimeDB server reachable', `${HTTP} did not answer`, 'Run `spacetime start` in its own terminal.');
  } else {
    add('PASS', 'SpacetimeDB server reachable', HTTP);
    const id = await fetch(`${HTTP}/v1/identity`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => null);
    token = id && id.ok ? ((await id.json()) as { token: string }).token : '';
  }

  let moduleOk = false;
  if (token) {
    try {
      const cfg = await sql('SELECT * FROM system_config');
      moduleOk = cfg.length > 0;
      add(moduleOk ? 'PASS' : 'FAIL', `Module '${DB}' published and initialized`, moduleOk ? 'system_config present' : 'no system_config row', 'Run `npm run publish:local`, then open the UI once.');
    } catch (e) {
      add('FAIL', `Module '${DB}' published`, (e as Error).message, 'Run `npm run publish:local` (non-destructive). Never use publish:fresh before a demo.');
    }
  } else if (ping?.ok) {
    add('FAIL', 'Anonymous read identity', 'could not obtain a token from /v1/identity');
  }

  if (moduleOk) {
    try {
      await sql('SELECT * FROM response_proposal');
      await sql('SELECT * FROM decision_explanation');
      add('PASS', 'Module includes Decision Lab tables', 'response_proposal, decision_explanation');
    } catch {
      add('FAIL', 'Module includes Decision Lab tables', 'tables missing — the published module is older than this code', 'Run `npm run publish:local` (additive migration, keeps data), then `npm run generate` only if you changed the schema.');
    }

    const assets = await sql('SELECT asset_id, name, criticality FROM asset');
    const edges = await sql('SELECT dependent_asset_id, required_asset_id, dependency_type FROM dependency');
    const seeded = DEMO_ASSETS.every(a => assets.some(x => x.asset_id === a.assetId));
    add(seeded ? 'PASS' : 'FAIL', 'Digital twin seeded (16 services)', `${assets.length} assets, ${edges.length} dependencies`, 'Open the UI once (it seeds idempotently) or Settings → Synchronize demo environment.');

    const s1 = await sql('SELECT tick_count, telemetry_enabled FROM simulation_state');
    await new Promise(r => setTimeout(r, 3500));
    const s2 = await sql('SELECT tick_count FROM simulation_state');
    const t1 = Number(s1[0]?.tick_count ?? -1);
    const t2 = Number(s2[0]?.tick_count ?? -1);
    add(t2 > t1 ? 'PASS' : 'FAIL', 'Simulation engine ticking', `tick ${t1} → ${t2}${s1[0]?.telemetry_enabled === false ? ' (synthetic telemetry paused)' : ''}`, 'Open the UI once so the scheduler is created; check `spacetime logs sentinelos-x`.');

    const responders = await sql('SELECT display_name, role, online FROM responder');
    const ic = responders.filter(r => r.role === 'incident_commander');
    add(ic.length > 0 ? 'PASS' : 'FAIL', 'Incident Commander registered', ic.map(r => r.display_name).join(', ') || 'none', 'Register in the first browser tab — the first responder becomes Incident Commander.');
    add(responders.length >= 2 ? 'PASS' : 'FAIL', 'Two responders for two-person approval', `${responders.length} registered`, 'Open a second browser window (or a private window) and register a second responder.');
    const cfg = await sql('SELECT dev_role_self_service FROM system_config');
    add('PASS', 'Role self-service (development mode)', cfg[0]?.dev_role_self_service ? 'ON — any responder can pick their own role. Fine for the demo; say so if asked.' : 'OFF — roles assigned by an Incident Commander only');

    const services = await sql('SELECT name, kind, status, online FROM service_principal');
    const agent = services.find(s => s.kind === 'ai_agent' && s.status !== 'revoked');
    add(
      agent?.status === 'authorized' && agent.online ? 'PASS' : 'FAIL',
      'Nemotron agent service authorized and online',
      agent ? `${agent.name}: ${agent.status}, ${agent.online ? 'online' : 'offline'}` : 'not connected',
      'Run `npm run agent`, then Settings → Services → Authorize. Without it the deterministic Decision Lab still works; AI panels show a degraded state.'
    );

    const incidents = await sql('SELECT incident_id, status, scenario_type, is_simulation FROM incident');
    const activeDb = incidents.find(i => i.scenario_type === 'database_outage' && i.status !== 'resolved');
    add(
      activeDb ? 'FAIL' : 'PASS',
      'Database-outage scenario can be launched',
      activeDb ? `INC-${activeDb.incident_id} is still active, so launching again will be refused` : `${SCENARIOS.length} scenarios available; none blocking`,
      'Recover and resolve it, or Settings → Reset demo environment (never deletes records; refuses if a REAL sensor incident is open).'
    );
    const realOpen = incidents.filter(i => i.is_simulation === false && i.status !== 'resolved');
    if (realOpen.length) add('FAIL', 'No unexpected REAL incidents open', `${realOpen.length} open real incident(s): ${realOpen.map(i => `INC-${i.incident_id}`).join(', ')}`, 'Resolve them from the incident page (they block Reset demo environment by design).');

    // Decision Lab readiness: run the real engine against the LIVE graph with a hypothetical outage. Nothing is written.
    try {
      const report = evaluateAll({
        incidentId: 'preflight',
        incidentStatus: 'open',
        assets: assets.map(a => ({ assetId: String(a.asset_id), name: String(a.name), criticality: a.criticality as never })),
        edges: edges.map(e => ({ dependentAssetId: String(e.dependent_asset_id), requiredAssetId: String(e.required_asset_id), dependencyType: e.dependency_type as never })),
        effects: [{ incidentId: 'preflight', assetId: 'primary-db', kind: 'outage', level: 'offline', phase: 'active', intensity: 0 }],
        targetAssetId: 'primary-db',
        pendingRecoveryAssetIds: [],
      });
      const restore = report.results.find(r => r.strategy === 'restore')!;
      add(report.results.length === 4 && restore.restored.length > 0 ? 'PASS' : 'FAIL', 'Decision Lab engine on live graph', `4 strategies evaluated; restore would return ${restore.restored.length} service(s) to healthy (in-memory only)`);
    } catch (e) {
      add('FAIL', 'Decision Lab engine on live graph', (e as Error).message);
    }

    const pendingExpl = await sql('SELECT explanation_id, status FROM decision_explanation');
    const stuck = pendingExpl.filter(x => x.status === 'requested' || x.status === 'running');
    if (stuck.length) add('FAIL', 'No stuck Nemotron requests', `${stuck.length} explanation request(s) waiting`, 'Cancel them in the Decision Lab, or start/authorize the agent.');
    void optSome;
  } else if (ping?.ok) {
    for (const n of ['Digital twin seeded', 'Simulation engine ticking', 'Responders and roles', 'Nemotron agent service', 'Scenario availability', 'Decision Lab engine on live graph']) add('SKIPPED', n, 'module not available');
  }

  // NVIDIA credential (presence only — the value is never printed)
  const key = svcEnv.NVIDIA_API_KEY ?? '';
  add(key.startsWith('nvapi-') && key.length > 20 ? 'PASS' : 'FAIL', 'NVIDIA API key configured (services/.env)', key ? `present (${key.length} chars, value hidden)` : 'missing', 'Put NVIDIA_API_KEY in SentinelOS-X/services/.env, then `npm --prefix services run agent:check` (makes one real API call).');
  add('PASS', 'Configured model', svcEnv.NEMOTRON_MODEL || 'nvidia/nemotron-3-super-120b-a12b (default)');

  // Frontend
  const fe = await get(FRONTEND);
  add(fe?.ok ? 'PASS' : 'FAIL', 'Frontend available', fe?.ok ? FRONTEND : `${FRONTEND} not answering`, 'Run `npm run dev` from SentinelOS-X/.');

  // Hardware bridge (optional)
  const hw = await get(`${BRIDGE}/health`);
  if (hw?.ok) {
    const h = (await hw.json()) as { spacetimedb?: boolean; sync_error?: string | null; sensor?: { age_s?: number | null; last_error?: string | null } };
    add('PASS', 'Hardware bridge reachable', `${BRIDGE} (SpacetimeDB link: ${h.spacetimedb ? 'configured' : 'standalone'})`);
    const age = h.sensor?.age_s;
    add(age !== null && age !== undefined && age < 15 ? 'PASS' : requireHardware ? 'FAIL' : 'SKIPPED', 'Sensor readings arriving', age === null || age === undefined ? 'no reading received yet' : `last reading ${age}s ago`, 'Check the Arduino is on the same 2.4 GHz network and BRIDGE_HOST matches this laptop IP.');
    if (h.sensor?.last_error || h.sync_error) add('FAIL', 'Bridge → SpacetimeDB forwarding', String(h.sensor?.last_error ?? h.sync_error), 'Authorize "Sentinel Gateway" in Settings → Services; check SPACETIMEDB_GATEWAY_TOKEN.');
  } else {
    add(requireHardware ? 'FAIL' : 'SKIPPED', 'Hardware bridge reachable', `${BRIDGE} not answering — hardware is optional; the demo runs without it`, 'From hardware/: python -m uvicorn bridge:app --host 0.0.0.0 --port 8765');
  }
  if (token) {
    try {
      const gw = (await sql('SELECT name, kind, status, online FROM service_principal')).find(s => s.kind === 'hardware_gateway' && s.status !== 'revoked');
      if (gw || requireHardware) add(gw?.status === 'authorized' ? 'PASS' : requireHardware ? 'FAIL' : 'SKIPPED', 'Sensor gateway service authorized', gw ? `${gw.name}: ${gw.status}` : 'not announced', 'Settings → Services → Authorize "Sentinel Gateway".');
    } catch {
      /* reported above */
    }
  }

  // Secret hygiene: nothing secret tracked by git
  for (const repo of [REPO, join(REPO, '..', 'agent')]) {
    if (!existsSync(join(repo, '.git'))) continue;
    try {
      const tracked = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).split('\n');
      const bad = tracked.filter(f => /(^|\/)\.env$|(^|\/)\.env\.(?!example$)|\.token$|arduino_secrets\.h$|\.pem$/.test(f));
      add(bad.length ? 'FAIL' : 'PASS', `No secrets tracked by git (${repo.split('/').pop()})`, bad.length ? bad.join(', ') : 'no .env / token / key files tracked', 'git rm --cached <file>, add to .gitignore, and ROTATE the credential.');
    } catch {
      add('SKIPPED', `Secret scan (${repo.split('/').pop()})`, 'git not available');
    }
  }

  const w = Math.max(...results.map(r => r.name.length));
  console.log(`\nSentinelOS X pre-demo check — ${new Date().toISOString()}\n`);
  for (const r of results) {
    console.log(`${r.status.padEnd(8)}${r.name.padEnd(w + 2)}${r.detail}`);
    if (r.status === 'FAIL' && r.fix) console.log(`${' '.repeat(8)}↳ ${r.fix}`);
  }
  const c = (s: Status) => results.filter(r => r.status === s).length;
  console.log(`\n${c('PASS')} PASS · ${c('FAIL')} FAIL · ${c('SKIPPED')} SKIPPED`);
  if (c('FAIL') > 0) {
    console.log('Not demo-ready. Fix the FAIL lines above (see docs/DEMO_RECOVERY.md).');
    process.exitCode = 1;
  } else console.log('Demo-ready.');
}

void main().catch(e => {
  console.error('Preflight crashed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
