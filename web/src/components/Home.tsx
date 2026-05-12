import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { PastScanSummary } from '../types.ts';

interface Props {
  navigate: (to: string) => void;
}

export function Home({ navigate }: Props) {
  const [scans, setScans] = useState<PastScanSummary[] | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const { scans, activeSlug } = await api.listScans();
      setScans(scans);
      setActiveSlug(activeSlug);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
    // poll lightly so the home page reflects an in-flight scan.
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="fade-in">
      <div className="home-head">
        <div>
          <h1 className="home-title">Workspaces</h1>
          <div className="home-sub">Repos you've scanned. Click a card to view its findings.</div>
        </div>
        <button type="button" className="btn primary" onClick={() => navigate('/new')}>
          + New scan
        </button>
      </div>

      {error && (
        <div className="error-banner" style={{ marginBottom: 16 }}>
          <div><div className="err-title">Could not load scans</div><div className="muted">{error}</div></div>
        </div>
      )}

      {scans === null && !error && (
        <div className="empty-state"><p>Loading…</p></div>
      )}

      {scans && scans.length === 0 && (
        <div className="empty-state fade-in">
          <h3>No scans yet</h3>
          <p>Run your first vulnerability scan on a local repo.</p>
          <button className="btn primary" onClick={() => navigate('/new')}>Scan a repo →</button>
        </div>
      )}

      {scans && scans.length > 0 && (
        <div className="scan-grid">
          {scans.map(s => {
            const isRunning = s.isActive || s.slug === activeSlug;
            const status: 'running' | 'completed' | 'aborted' | 'error' = isRunning
              ? 'running'
              : (s.status ?? 'completed');
            return (
              <button
                key={s.slug}
                type="button"
                className="scan-card"
                onClick={() => navigate(`/scans/${encodeURIComponent(s.slug)}`)}
              >
                <div className="card-head">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="repo-path">{shortPath(s.repoPath)}</div>
                    <div className="repo-meta">{s.provider} · {s.effort} effort · parallel {s.parallel}</div>
                  </div>
                  <span className={`status-pill ${status}`}>{status}</span>
                </div>

                <div className="sev-tiles">
                  <SevTile label="verified" count={s.verifiedCount} kind="critical" />
                  <SevTile label="candidates" count={s.candidateCount} kind="neutral" />
                  <SevTile label="files" count={s.fileCount} kind="neutral" />
                </div>

                <div className="card-footer">
                  <span>last run · {formatRelative(s.lastUpdatedAt)}</span>
                  <span className="mono" style={{ color: 'var(--text-3)' }}>{s.slug.slice(-8)}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SevTile({ label, count, kind }: { label: string; count: number; kind: 'critical' | 'neutral' }) {
  return (
    <span className={`sev-tile ${kind === 'critical' ? 'critical' : ''}`}>
      <span className="num">{count}</span>
      <span>{label}</span>
    </span>
  );
}

function shortPath(p: string): string {
  if (!p) return '—';
  const home = (typeof window !== 'undefined' && (window as any).__HOME__) || '';
  let str = p;
  if (home && str.startsWith(home)) str = '~' + str.slice(home.length);
  const segs = str.split('/');
  if (segs.length <= 5) return str;
  return segs.slice(0, 2).join('/') + '/…/' + segs.slice(-2).join('/');
}

function formatRelative(ts: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}
