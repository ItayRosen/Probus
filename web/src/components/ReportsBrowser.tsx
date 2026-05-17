import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import { api } from '../api.ts';
import type { ReportSummary, Severity } from '../types.ts';

interface Props {
  slug: string;
  repoPath?: string;
  reports: ReportSummary[];
  onRescan: () => void;
  onFix?: (reportId: string) => void;
}

const SEV_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

export function ReportsBrowser({ slug, repoPath, reports, onRescan, onFix }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(reports[0]?.reportId ?? null);
  const [markdown, setMarkdown] = useState<string>('');
  const [loading, setLoading] = useState(false);

  // Keep selection valid if the report list changes.
  useEffect(() => {
    if (selectedId && reports.some(r => r.reportId === selectedId)) return;
    setSelectedId(reports[0]?.reportId ?? null);
  }, [reports, selectedId]);

  const groups = useMemo(() => {
    const byKey = new Map<Severity, ReportSummary[]>();
    for (const r of reports) {
      const arr = byKey.get(r.severity) ?? [];
      arr.push(r);
      byKey.set(r.severity, arr);
    }
    return SEV_ORDER
      .map(sev => ({ sev, items: byKey.get(sev) ?? [] }))
      .filter(g => g.items.length > 0);
  }, [reports]);

  useEffect(() => {
    if (!selectedId) { setMarkdown(''); return; }
    setLoading(true);
    api.scanReport(slug, selectedId)
      .then(({ markdown }) => setMarkdown(markdown))
      .catch(err => setMarkdown(`# Could not load report\n\n${String(err)}`))
      .finally(() => setLoading(false));
  }, [slug, selectedId]);

  if (reports.length === 0) {
    return (
      <div className="fade-in">
        <div className="home-head">
          <div>
            <h1 className="home-title">Scan complete</h1>
            <div className="home-sub mono" style={{ fontSize: 12 }}>{repoPath ?? slug}</div>
          </div>
          <button type="button" className="btn primary" onClick={onRescan}>Run again</button>
        </div>
        <div className="panel">
          <div className="analyst-panel">
            <div style={{ fontSize: 44, lineHeight: 1, color: 'var(--ok)' }}>✓</div>
            <div className="analyst-title" style={{ marginTop: 12 }}>No verified vulnerabilities</div>
            <div className="analyst-sub">
              The scan completed without confirming any critical/high vulnerabilities.
              Re-run with higher <span className="mono">effort</span> for broader coverage.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const selected = reports.find(r => r.reportId === selectedId) ?? null;

  return (
    <div className="fade-in col">
      <div className="home-head">
        <div>
          <h1 className="home-title">
            {reports.length} {reports.length === 1 ? 'finding' : 'findings'}
          </h1>
          <div className="home-sub mono" style={{ fontSize: 12 }}>{repoPath ?? slug}</div>
        </div>
        <button type="button" className="btn ghost" onClick={onRescan}>Run again</button>
      </div>

      <div className="split">
        <aside className="panel findings-list">
          <div className="panel-header" style={{ position: 'sticky', top: 0, background: 'var(--bg-panel)', zIndex: 1 }}>
            <div className="panel-title">Findings</div>
            <span className="spacer" />
            <span className="chip">{reports.length}</span>
          </div>
          {groups.map(g => (
            <div key={g.sev}>
              <div className="severity-group">
                <span style={{ color: severityColor(g.sev) }}>{g.sev}</span>
                <span style={{ marginLeft: 6, opacity: 0.5 }}>· {g.items.length}</span>
              </div>
              {g.items.map(r => {
                const isSel = r.reportId === selectedId;
                return (
                  <div
                    key={r.reportId}
                    className={`finding-row${isSel ? ' selected' : ''}`}
                    onClick={() => setSelectedId(r.reportId)}
                  >
                    <div className="row" style={{ gap: 8 }}>
                      <span className={`sev ${g.sev}`}>{g.sev}</span>
                      <span className="file" style={{ flex: 1, minWidth: 0 }}>{shortPath(r.file)}</span>
                    </div>
                    <div className="name">{r.name}</div>
                  </div>
                );
              })}
            </div>
          ))}
        </aside>

        <main className="panel" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {selected && (
            <div className="panel-header" style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <span className={`sev ${selected.severity}`}>{selected.severity}</span>
              <span className="panel-title" style={{ textTransform: 'none', letterSpacing: 0 }}>{selected.name}</span>
              <span className="spacer" />
              <span className="muted mono" style={{ fontSize: 11 }}>{shortPath(selected.file)}</span>
              {onFix && (
                <button
                  className="btn primary"
                  style={{ marginLeft: 10 }}
                  onClick={() => onFix(selected.reportId)}
                  title="Open chat with the agent to fix this and create a PR"
                >
                  Fix → PR
                </button>
              )}
            </div>
          )}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loading
              ? <div className="markdown muted">Loading…</div>
              : (
                <div
                  className="markdown"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown) }}
                />
              )}
          </div>
        </main>
      </div>
    </div>
  );
}

function severityColor(s: Severity): string {
  switch (s) {
    case 'critical': return 'var(--sev-critical)';
    case 'high': return 'var(--sev-high)';
    case 'medium': return 'var(--sev-medium)';
    case 'low': return 'var(--sev-low)';
  }
}

function shortPath(p: string): string {
  const segs = p.split('/');
  if (segs.length <= 4) return p;
  return '…/' + segs.slice(-3).join('/');
}

marked.setOptions({ async: false, gfm: true, breaks: false });

function renderMarkdown(src: string): string {
  if (!src) return '';
  return marked.parse(src) as string;
}
