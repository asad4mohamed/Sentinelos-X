// SentinelOS X — NVIDIA Nemotron investigation agent.
//   npm run agent         run as a SpacetimeDB service (needs IC authorization)
//   npm run agent:check   verify NVIDIA API key, endpoint and model, then exit
import { env, loadEnv, log, startService } from '../shared/service';
import { tables } from '../module_bindings/index';
import { OpenAiCompatibleClient } from './llm';
import { runInvestigation } from './investigator';
import { twinFromConnection } from './twin';
import { explainDecision } from './explain';
import { redactSecrets } from './llm';
import { evaluateAll, type LabInput } from '../../../spacetime/src/decisionLab';
import type { DbConnection } from '../module_bindings/index';

loadEnv();
const cfg = {
  baseUrl: env('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1'),
  apiKey: env('NVIDIA_API_KEY', ''),
  model: env('NEMOTRON_MODEL', 'nvidia/nemotron-3-super-120b-a12b'),
  thinking: env('NEMOTRON_THINKING', 'false') === 'true',
  timeoutMs: Number(env('NEMOTRON_TIMEOUT_MS', '180000')) || 180000,
};
const maxTurns = Math.min(20, Math.max(3, Number(env('AGENT_MAX_TURNS', '12')) || 12));
const llm = new OpenAiCompatibleClient({ ...cfg, maxRetries: Math.min(5, Math.max(0, Number(env('NEMOTRON_MAX_RETRIES', '2')) || 0)) });
const safe = (err: unknown) => redactSecrets(err instanceof Error ? err.message : String(err), cfg.apiKey);

/** Decision Lab input from the agent's subscription cache (same engine the module uses). */
function labInputFrom(conn: DbConnection, incidentId: bigint, targetAssetId: string): LabInput | null {
  const inc = [...conn.db.incident.iter()].find(i => i.incidentId === incidentId);
  if (!inc) return null;
  return {
    incidentId: String(incidentId),
    incidentStatus: inc.status,
    assets: [...conn.db.asset.iter()].map(a => ({ assetId: a.assetId, name: a.name, criticality: a.criticality as never })),
    edges: [...conn.db.dependency.iter()].map(d => ({ dependentAssetId: d.dependentAssetId, requiredAssetId: d.requiredAssetId, dependencyType: d.dependencyType as never })),
    effects: [...conn.db.incidentEffect.iter()].filter(e => e.phase !== 'cleared').map(e => ({ incidentId: String(e.incidentId), assetId: e.assetId, kind: e.kind as never, level: e.level === 'offline' ? 'offline' : 'degraded', phase: e.phase as never, intensity: e.intensity })),
    targetAssetId,
    pendingRecoveryAssetIds: [...conn.db.recoveryAction.iter()].filter(r => r.incidentId === incidentId && r.status === 'pending').map(r => r.assetId),
  };
}

async function check() {
  log('agent', `Endpoint ${cfg.baseUrl} · model ${cfg.model} · thinking ${cfg.thinking}`);
  if (!cfg.apiKey) {
    log('agent', 'NVIDIA_API_KEY is not set. Create one at https://build.nvidia.com and put it in services/.env');
    process.exit(1);
  }
  try {
    const models = await llm.listModels();
    const nemotrons = models.filter(m => m.toLowerCase().includes('nemotron'));
    log('agent', models.includes(cfg.model) ? `Model ${cfg.model} is available.` : `WARNING: ${cfg.model} not in /models. Nemotron models visible: ${nemotrons.join(', ') || 'none'}`);
    const r = await llm.chat([{ role: 'user', content: 'Reply with the single word: ready' }], []);
    log('agent', `Test completion OK: ${JSON.stringify((r.content ?? '').trim().slice(0, 80))}`);
    process.exit(0);
  } catch (err) {
    log('agent', 'Check failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

if (process.argv.includes('--check')) {
  void check();
} else {
  if (!cfg.apiKey) {
    log('agent', 'NVIDIA_API_KEY is not set — the agent will connect but will NOT claim investigations. No output is ever fabricated.');
  }
  startService({
    slug: 'agent',
    name: 'Nemotron Investigator',
    kind: 'ai_agent',
    subscribe: [
      tables.asset,
      tables.dependency,
      tables.incident,
      tables.incidentAsset,
      tables.incidentEvent,
      tables.recoveryAction,
      tables.telemetrySample,
      tables.aiInvestigation,
      tables.aiFinding,
      tables.incidentEvidence,
      tables.sensorNode,
      tables.sensorReading,
      tables.incidentEffect,
      tables.decisionExplanation,
    ],
    onReady: ({ conn, authState }) => {
      const twin = twinFromConnection(conn);
      let busy = false;

      const pump = async () => {
        if (busy || !cfg.apiKey || authState() !== 'authorized' || !conn.isActive) return;
        const next = [...conn.db.aiInvestigation.iter()].filter(i => i.status === 'requested').sort((a, b) => (a.investigationId < b.investigationId ? -1 : 1))[0];
        if (!next) return;
        busy = true;
        const investigationId = next.investigationId;
        const incidentId = String(next.incidentId);
        try {
          await conn.reducers.agentClaimInvestigation({ investigationId, model: cfg.model });
        } catch (err) {
          log('agent', `Could not claim #${investigationId}:`, safe(err));
          busy = false;
          return;
        }
        log('agent', `Investigating INC-${incidentId} (investigation #${investigationId}) with ${cfg.model}`);
        try {
          const outcome = await runInvestigation({
            llm,
            twin,
            incidentId,
            maxTurns,
            limits: {
              maxToolCalls: Math.min(40, Math.max(4, Number(env('AGENT_MAX_TOOL_CALLS', '24')) || 24)),
              maxSeconds: Math.min(900, Math.max(30, Number(env('AGENT_MAX_SECONDS', '300')) || 300)),
            },
            sink: {
              step: s => conn.reducers.agentRecordStep({ investigationId, kind: s.kind, tool: s.tool ?? undefined, inputSummary: s.input, outputSummary: s.output, ok: s.ok }),
              finding: f =>
                conn.reducers.agentRecordFinding({ investigationId, kind: f.kind, summary: f.summary, evidence: f.evidence, assetId: f.assetId ?? undefined, confidence: f.confidence }),
            },
          });
          await conn.reducers.agentCompleteInvestigation({ investigationId, summary: outcome.summary.slice(0, 2000), failed: false });
          log('agent', `Completed #${investigationId}: ${outcome.toolCalls} tool calls, ${outcome.findings} findings, ${outcome.recommendations} recommendations`);
        } catch (err) {
          const msg = safe(err);
          log('agent', `Investigation #${investigationId} failed: ${msg}`);
          await conn.reducers.agentCompleteInvestigation({ investigationId, summary: msg.slice(0, 2000), failed: true }).catch(() => {});
        } finally {
          busy = false;
          void pump();
        }
      };

      // ── Decision Lab explanations (one at a time, independent of investigations) ──
      let explaining = false;
      const pumpExplain = async () => {
        if (explaining || !cfg.apiKey || authState() !== 'authorized' || !conn.isActive) return;
        const next = [...conn.db.decisionExplanation.iter()].filter(x => x.status === 'requested').sort((a, b) => (a.explanationId < b.explanationId ? -1 : 1))[0];
        if (!next) return;
        explaining = true;
        const explanationId = next.explanationId;
        try {
          await conn.reducers.agentClaimExplanation({ explanationId, model: cfg.model });
        } catch (err) {
          log('agent', `Could not claim explanation #${explanationId}:`, safe(err));
          explaining = false;
          return;
        }
        try {
          const input = labInputFrom(conn, next.incidentId, next.targetAssetId);
          if (!input) throw new Error(`Incident ${next.incidentId} not visible to agent`);
          const report = evaluateAll(input); // deterministic; the model never computes results
          const inc = [...conn.db.incident.iter()].find(i => i.incidentId === next.incidentId)!;
          const assets = new Map([...conn.db.asset.iter()].map(a => [a.assetId, a.name]));
          const evidence = [...conn.db.incidentEvidence.iter()]
            .filter(e => e.incidentId === next.incidentId)
            .sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : 1))
            .map(e => ({ id: String(e.evidenceId), title: e.title, detail: e.detail, source: (e.synthetic ? 'synthetic' : 'measured') as 'synthetic' | 'measured' }));
          log('agent', `Explaining Decision Lab comparison for INC-${next.incidentId} (#${explanationId})`);
          const out = await explainDecision(llm, { incidentId: String(next.incidentId), incidentTitle: inc.title, isSimulation: inc.isSimulation, report, evidence, nameOf: id => assets.get(id) ?? id });
          await conn.reducers.agentCompleteExplanation({ explanationId, text: out.text, citedEvidence: out.cited.map(BigInt), failed: false });
          log('agent', `Explanation #${explanationId} completed (${out.cited.length} citations)`);
        } catch (err) {
          const msg = safe(err);
          log('agent', `Explanation #${explanationId} failed: ${msg}`);
          await conn.reducers.agentCompleteExplanation({ explanationId, text: msg.slice(0, 3900) || 'failed', citedEvidence: [], failed: true }).catch(() => {});
        } finally {
          explaining = false;
          void pumpExplain();
        }
      };

      conn.db.aiInvestigation.onInsert(() => void pump());
      conn.db.aiInvestigation.onUpdate(() => void pump());
      conn.db.decisionExplanation.onInsert(() => void pumpExplain());
      conn.db.servicePrincipal.onUpdate(() => {
        void pump();
        void pumpExplain();
      });
      setInterval(() => {
        void pump();
        void pumpExplain();
      }, 5000);
      void pump();
      void pumpExplain();
      log('agent', `Ready. Model ${cfg.model} via ${cfg.baseUrl}. Waiting for investigation requests.`);
    },
  });
}
