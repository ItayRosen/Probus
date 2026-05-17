// Orchestrates "what to show for /scans/:slug":
//   - If a scan with this slug is actively running → ScanDashboard with SSE
//   - Otherwise (completed/past) → ReportsBrowser
//
// Polls /api/active in case the scan finishes while the user is watching,
// or in case they navigated here before the runner is registered.

import { useEffect, useState } from 'react';
import { api, subscribeEvents } from '../api.ts';
import type {
  ReportSummary,
  ScanDetailResponse,
  ScanState,
  ServerEvent,
} from '../types.ts';
import { ScanDashboard } from './ScanDashboard.tsx';
import { ReportsBrowser } from './ReportsBrowser.tsx';

interface Props {
  slug: string;
  navigate: (to: string) => void;
}

export function ScanView({ slug, navigate }: Props) {
  const [detail, setDetail] = useState<ScanDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<ScanState | null>(null);
  const [reports, setReports] = useState<ReportSummary[] | null>(null);

  // Initial detail fetch.
  useEffect(() => {
    let mounted = true;
    setDetail(null);
    setError(null);
    setLiveState(null);
    setReports(null);
    api.getScan(slug)
      .then(d => {
        if (!mounted) return;
        setDetail(d);
        setLiveState(d.state);
        setReports(d.reports);
      })
      .catch(err => {
        if (!mounted) return;
        const e = err as { status?: number; message?: string };
        if (e?.status === 404) setError('This scan no longer exists.');
        else setError(e?.message ?? String(err));
      });
    return () => { mounted = false; };
  }, [slug]);

  // SSE subscription while the scan is running.
  useEffect(() => {
    if (!detail?.isRunning) return;
    const unsub = subscribeEvents(slug, (ev: ServerEvent) => {
      setLiveState(prev => applyEvent(prev ?? detail.state, ev));
      if (ev.type === 'done' || (ev.type === 'phase' && (ev.phase === 'browse' || ev.phase === 'done'))) {
        // Pipeline finished — refresh detail to flip isRunning false and load reports.
        api.getScan(slug).then(d => {
          setDetail(d);
          setReports(d.reports);
        }).catch(() => {/* ignore */});
      }
    });
    return unsub;
  }, [slug, detail?.isRunning]);

  if (error) {
    return (
      <div className="empty-state fade-in">
        <h3>Couldn't open this scan</h3>
        <p>{error}</p>
        <button className="btn primary" onClick={() => navigate('/')}>Back to scans</button>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="panel fade-in">
        <div className="analyst-panel">
          <div className="analyst-spin" />
          <div className="analyst-title">Loading</div>
        </div>
      </div>
    );
  }

  if (detail.isRunning && liveState) {
    return (
      <ScanDashboard
        state={liveState}
        repoPath={detail.metadata?.repoPath}
        onSkip={async (idx) => { try { await api.skipFile(slug, idx); } catch { /* ignore */ } }}
        onAbort={async () => { try { await api.abortScan(slug); } catch { /* ignore */ } }}
      />
    );
  }

  // Completed / past scan.
  return (
    <ReportsBrowser
      slug={slug}
      repoPath={detail.metadata?.repoPath}
      reports={reports ?? []}
      onRescan={() => navigate('/new')}
      onFix={(reportId) => navigate(`/scans/${encodeURIComponent(slug)}/fix/${encodeURIComponent(reportId)}`)}
    />
  );
}

function applyEvent(prev: ScanState | null, ev: ServerEvent): ScanState | null {
  if (ev.type === 'snapshot') return ev.state;
  if (!prev) return prev;
  switch (ev.type) {
    case 'phase': return { ...prev, phase: ev.phase };
    case 'analyst-chunk': return { ...prev, analystThought: ev.text };
    case 'files-init': return { ...prev, files: ev.files };
    case 'file-update': {
      const next = prev.files.slice();
      const cur = next[ev.index];
      if (cur) next[ev.index] = { ...cur, ...ev.patch };
      return { ...prev, files: next };
    }
    case 'tokens': return { ...prev, tokens: ev.tokens };
    case 'error': return { ...prev, fatalError: ev.message, phase: 'error' };
    case 'done': return prev;
    default: return prev;
  }
}
