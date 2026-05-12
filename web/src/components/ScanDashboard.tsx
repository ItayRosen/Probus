import { useMemo, useState } from 'react';
import type { FileEntry, FileStatus, ScanState } from '../types.ts';

interface Props {
  state: ScanState;
  repoPath?: string;
  onSkip: (index: number) => void;
  onAbort: () => void;
}

const STATUS_ICON: Record<FileStatus, string> = {
  pending: '○',
  scanning: '⚡',
  verifying: '🔎',
  done: '✓',
  skipped: '⊘',
  error: '!',
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fileSummary(f: FileEntry): string {
  if (f.status === 'scanning') return 'researching…';
  if (f.status === 'verifying') return `${f.totalFindings ?? 0} candidates · verifying`;
  if (f.status === 'done') {
    if (f.totalFindings === undefined) return '—';
    return `${f.realFindings ?? 0} verified · ${f.totalFindings} candidates`;
  }
  if (f.status === 'skipped') return 'skipped';
  if (f.status === 'error') return 'error';
  return '';
}

export function ScanDashboard({ state, repoPath, onSkip, onAbort }: Props) {
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const stats = useMemo(() => {
    let done = 0, scanning = 0, errors = 0, skipped = 0, verifiedRaw = 0, totalCandidates = 0;
    for (const f of state.files) {
      if (f.status === 'done') done++;
      else if (f.status === 'scanning' || f.status === 'verifying') scanning++;
      else if (f.status === 'error') errors++;
      else if (f.status === 'skipped') skipped++;
      if (typeof f.realFindings === 'number') verifiedRaw += f.realFindings;
      if (typeof f.totalFindings === 'number') totalCandidates += f.totalFindings;
    }
    const total = state.files.length;
    const finished = done + skipped + errors;
    const pct = total ? Math.floor((finished / total) * 100) : 0;
    return {
      done, scanning, errors, skipped, finished, total, pct,
      verified: state.resumedFindings + verifiedRaw,
      totalCandidates,
    };
  }, [state.files, state.resumedFindings]);

  // While the analyst is choosing files we don't have a list yet.
  if (state.phase === 'analyst' || (state.files.length === 0 && state.phase !== 'error')) {
    return (
      <div className="fade-in">
        <div className="home-head">
          <div>
            <h1 className="home-title">Scanning</h1>
            <div className="home-sub mono" style={{ fontSize: 12 }}>{repoPath ?? state.targetRepo}</div>
          </div>
          <button type="button" className="btn danger" onClick={onAbort}>Abort</button>
        </div>
        <div className="panel">
          <div className="analyst-panel">
            <div className="analyst-spin" />
            <div className="analyst-title">Mapping the codebase</div>
            <div className="analyst-sub">
              The analyst is scanning your repo to pick entry points, third-party surface and dangerous sinks for deep review.
            </div>
            {state.analystThought && (
              <div className="analyst-thought">{state.analystThought}</div>
            )}
            <div className="row" style={{ marginTop: 28, gap: 14, color: 'var(--text-3)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
              <span>↓ {fmtTokens(state.tokens)} tokens</span>
              <span>·</span>
              <span>effort: {state.effort}</span>
              <span>·</span>
              <span>parallel: {state.parallel}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in col">
      <div className="home-head">
        <div>
          <h1 className="home-title">Scanning</h1>
          <div className="home-sub mono" style={{ fontSize: 12 }}>{repoPath ?? state.targetRepo}</div>
        </div>
        <button type="button" className="btn danger" onClick={onAbort}>Abort scan</button>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="stat-label">Progress</div>
          <div className="stat-value">{stats.pct}%</div>
          <div className="progress" style={{ marginTop: 8 }}>
            <div className="bar" style={{ width: `${stats.pct}%` }} />
          </div>
          <div className="stat-sub">{stats.finished} / {stats.total} files</div>
        </div>
        <div className="stat">
          <div className="stat-label">Verified vulnerabilities</div>
          <div className="stat-value" style={{ color: 'var(--sev-critical)' }}>{stats.verified}</div>
          <div className="stat-sub">{stats.totalCandidates} raw candidates this run</div>
        </div>
        <div className="stat">
          <div className="stat-label">In flight</div>
          <div className="stat-value">{stats.scanning}</div>
          <div className="stat-sub">{state.parallel} lanes</div>
        </div>
        <div className="stat">
          <div className="stat-label">Tokens</div>
          <div className="stat-value">{fmtTokens(state.tokens)}</div>
          <div className="stat-sub">{state.provider}</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">Pipeline · per-file</div>
          <span className="chip dot" style={{ color: 'var(--accent)' }}>
            <span>analyst → researcher → qa</span>
          </span>
          <span className="spacer" />
          <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            {state.primaryModel} → {state.secondaryModel}
          </span>
        </div>

        <div className="file-list">
          {state.files.map((f, i) => {
            const isSelected = selectedIdx === i;
            const inFlight = f.status === 'scanning' || f.status === 'verifying';
            return (
              <div key={f.path + i}>
                <div
                  className={`file-row ${f.status}${isSelected ? ' selected' : ''}`}
                  onClick={() => setSelectedIdx(isSelected ? null : i)}
                >
                  <span className={`icon ${f.status}`} title={f.status}>{STATUS_ICON[f.status]}</span>
                  <span className="path" title={f.path}>{f.path}</span>
                  <span className="status-meta">
                    <span>{fileSummary(f)}</span>
                    {inFlight && (
                      <button
                        type="button"
                        className="file-action"
                        onClick={e => { e.stopPropagation(); onSkip(i); }}
                      >
                        Skip
                      </button>
                    )}
                  </span>
                </div>
                {isSelected && f.lastThought && (
                  <div className="file-thought">{f.lastThought}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
