// Download the incident report (Markdown, or printable HTML → Print → Save as PDF).
import { FileDown, Printer } from 'lucide-react';
import { useSentinel } from '../hooks/useSentinelData';
import { useToast } from './Toast';
import { buildIncidentReport, download, reportHtml } from '../lib/report';

export function ExportReport({ incidentId }: { incidentId: bigint }) {
  const d = useSentinel();
  const toast = useToast();
  const go = (fmt: 'md' | 'html') => {
    const md = buildIncidentReport(d, incidentId);
    if (!md) {
      toast('error', `INC-${incidentId} not found`);
      return;
    }
    const name = `sentinelos-x-INC-${incidentId}-report`;
    if (fmt === 'md') download(`${name}.md`, md, 'text/markdown;charset=utf-8');
    else download(`${name}.html`, reportHtml(md, `SentinelOS X — INC-${incidentId}`), 'text/html;charset=utf-8');
    toast('success', fmt === 'md' ? 'Report downloaded (.md)' : 'Printable report downloaded — open it and Print → Save as PDF');
  };
  return (
    <>
      <button className="btn-ghost" onClick={() => go('md')} title="Download the incident report as Markdown">
        <FileDown className="size-4" /> Report .md
      </button>
      <button className="btn-ghost" onClick={() => go('html')} title="Download a printable HTML report (Print → Save as PDF)">
        <Printer className="size-4" /> Printable
      </button>
    </>
  );
}
