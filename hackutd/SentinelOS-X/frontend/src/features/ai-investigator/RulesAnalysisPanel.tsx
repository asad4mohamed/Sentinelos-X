// Deterministic, rules-based analysis panel. Shown automatically when NVIDIA
// Nemotron is unavailable (no authorized online agent, or the last investigation
// failed). It is labeled as rules-based so it can never be mistaken for AI output.
import { useMemo, useState } from 'react';
import { Calculator, ChevronDown, ChevronRight } from 'lucide-react';
import { useSentinel } from '../../hooks/useSentinelData';
import { Panel } from '../../components/ui';
import { RULES_LABEL, RULES_LABEL_CROSSCHECK, rulesAnalysis } from '../../lib/rulesAnalysis';
import type { Incident } from '../../types/domain';

export function nemotronUnavailable(d: ReturnType<typeof useSentinel>, incidentId: bigint | undefined): { unavailable: boolean; why: string } {
  const agent = d.services.find(s => s.kind === 'ai_agent' && s.status !== 'revoked');
  if (!agent) return { unavailable: true, why: 'No Nemotron agent is connected.' };
  if (agent.status !== 'authorized') return { unavailable: true, why: 'The Nemotron agent is awaiting authorization.' };
  if (!agent.online) return { unavailable: true, why: 'The Nemotron agent is offline.' };
  const last = d.aiInvestigations.filter(i => i.incidentId === incidentId).sort((a, b) => (a.investigationId < b.investigationId ? 1 : -1))[0];
  if (last?.status === 'failed') return { unavailable: true, why: `The last Nemotron investigation for this incident failed${(last.error ?? last.summary) ? `: ${(last.error ?? last.summary ?? "").slice(0, 140)}` : ""}.` };
  return { unavailable: false, why: '' };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{title}</h4>
      {children}
    </section>
  );
}

export function RulesAnalysisPanel({ incident }: { incident: Incident }) {
  const d = useSentinel();
  const status = nemotronUnavailable(d, incident.incidentId);
  const [open, setOpen] = useState(false);
  const show = status.unavailable || open;
  const a = useMemo(() => (show ? rulesAnalysis(d, incident.incidentId) : null), [show, d, incident.incidentId]);
  const label = status.unavailable ? RULES_LABEL : RULES_LABEL_CROSSCHECK;

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          <Calculator className="size-3.5" /> {label}
        </span>
      }
      actions={
        !status.unavailable && (
          <button className="btn-ghost px-2 py-1 text-xs" aria-expanded={open} onClick={() => setOpen(o => !o)}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} {open ? 'Hide' : 'Show'}
          </button>
        )
      }
    >
      {!show ? (
        <p className="text-xs text-slate-500">A deterministic cross-check from recorded data, available any time. Not AI output.</p>
      ) : !a ? (
        <p className="text-xs text-slate-500">Incident not found.</p>
      ) : (
        <div className="space-y-3 text-xs" data-testid="rules-analysis">
          {status.unavailable && (
            <p role="status" className="rounded-md border border-amber-500/40 bg-amber-950/40 px-3 py-2 text-amber-100">
              {status.why} The analysis below uses explicit rules over INC-{String(a.incidentId)}'s recorded data. It is not produced by NVIDIA Nemotron or any language model.
            </p>
          )}
          <Section title={`Observed (${a.kind})`}>
            {a.observed.length === 0 ? (
              <p className="text-slate-500">No evidence recorded.</p>
            ) : (
              <ul className="space-y-0.5">
                {a.observed.map((o, i) => (
                  <li key={i} className="text-slate-300">
                    {o.text} <span className="text-slate-500">[{o.basis}]</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Where effects are recorded (confirmed)">
            {a.roots.length === 0 ? <p className="text-slate-500">No live effects — services are recovered or recovering.</p> : a.roots.map(r => <p key={r.assetId} className="text-red-200">{r.name}: {r.effects.join(', ')}</p>)}
          </Section>
          <Section title={`Modeled downstream impact (${a.modeledImpact.length}) and exposure (${a.modeledExposure.length})`}>
            {a.modeledImpact.length + a.modeledExposure.length === 0 ? (
              <p className="text-slate-500">None predicted.</p>
            ) : (
              <ul className="space-y-0.5 text-orange-100">
                {a.modeledImpact.map(m => (
                  <li key={m.assetId}>
                    {m.name} — predicted {m.state}{m.via ? ` via ${m.via}` : ''} (hop {m.depth})
                  </li>
                ))}
                {a.modeledExposure.map(m => (
                  <li key={`x-${m.assetId}`} className="text-violet-200">
                    {m.name} — potentially exposed{m.via ? ` via ${m.via}` : ''} (not confirmed)
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={`Severity ${a.severity} — rules that apply`}>
            <ul className="list-disc space-y-0.5 pl-4 text-slate-300">
              {a.severityReasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </Section>
          <Section title="Response options (from the Decision Lab engine, hypothetical)">
            {a.responseOptions.length === 0 ? (
              <p className="text-slate-500">None — nothing left to respond to.</p>
            ) : (
              <ul className="space-y-1">
                {a.responseOptions.map((o, i) => (
                  <li key={i} className="text-slate-300">
                    <span className="font-medium text-slate-100">{o.name}</span> <span className={o.support === 'executable' ? 'text-emerald-300' : 'text-violet-300'}>[{o.support}]</span>
                    <div className="text-slate-400">{o.summary}</div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Missing evidence">
            <ul className="list-disc space-y-0.5 pl-4 text-amber-100">
              {a.missingEvidence.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </Section>
          <Section title="Limitations">
            <ul className="list-disc space-y-0.5 pl-4 text-slate-400">
              {a.limitations.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </Section>
        </div>
      )}
    </Panel>
  );
}
