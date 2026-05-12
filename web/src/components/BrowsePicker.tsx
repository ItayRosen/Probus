// Server-side directory picker. The web app can't get an absolute path
// out of <input webkitdirectory> or showDirectoryPicker(), so we let users
// navigate the localhost filesystem through /api/fs/list — same machine,
// same permissions they already have.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import type { FsListResponse, FsRootsResponse } from '../types.ts';

interface Props {
  initialPath: string | null;
  homeHint?: string;
  onPick: (absolutePath: string) => void;
  onCancel: () => void;
}

export function BrowsePicker({ initialPath, homeHint, onPick, onCancel }: Props) {
  const [roots, setRoots] = useState<FsRootsResponse | null>(null);
  const [listing, setListing] = useState<FsListResponse | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async (path: string | null | undefined) => {
    setError(null);
    setLoading(true);
    try {
      const data = await api.fsList(path ?? undefined);
      setListing(data);
      setFilter('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // Bootstrap: load roots + initial listing
  useEffect(() => {
    let mounted = true;
    api.fsRoots().then(r => { if (mounted) setRoots(r); }).catch(() => {/* ignore */});
    void load(initialPath || undefined);
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const breadcrumb = useMemo(() => {
    if (!listing) return [] as Array<{ label: string; path: string }>;
    return buildBreadcrumb(listing.path, homeHint ?? roots?.home);
  }, [listing, roots?.home, homeHint]);

  const visibleEntries = useMemo(() => {
    if (!listing) return [];
    let xs = listing.entries.filter(e => e.isDir); // dirs only — files aren't pickable
    if (!showHidden) xs = xs.filter(e => !e.hidden);
    const f = filter.trim().toLowerCase();
    if (f) xs = xs.filter(e => e.name.toLowerCase().includes(f));
    return xs;
  }, [listing, showHidden, filter]);

  const goTo = (p: string) => { void load(p); };
  const goUp = () => { if (listing?.parent) goTo(listing.parent); };
  const select = () => { if (listing) onPick(listing.path); };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="modal picker fade-in" role="dialog" aria-modal="true" aria-label="Pick a directory">
        <div className="modal-head">
          <span className="panel-title" style={{ textTransform: 'none', letterSpacing: 0 }}>Pick a repository</span>
          <span className="spacer" />
          <button className="btn ghost" onClick={onCancel} aria-label="Close picker">✕</button>
        </div>

        <div className="picker-body">
          <aside className="picker-sidebar">
            <div className="picker-sidebar-title">Quick access</div>
            {(roots?.roots ?? []).map(r => {
              const sel = listing?.path === r.path;
              return (
                <button
                  key={r.path}
                  type="button"
                  className={`picker-sidebar-item${sel ? ' selected' : ''}`}
                  onClick={() => goTo(r.path)}
                  title={r.path}
                >
                  <span className="picker-sidebar-icon">●</span>
                  <span>{r.label}</span>
                </button>
              );
            })}
          </aside>

          <section className="picker-main">
            <div className="picker-bar">
              <button
                type="button"
                className="picker-up"
                onClick={goUp}
                disabled={!listing?.parent}
                title="Up one level"
              >↑</button>
              <div className="picker-breadcrumb">
                {breadcrumb.map((b, i) => (
                  <span key={b.path}>
                    {i > 0 && <span className="picker-crumb-sep">/</span>}
                    <button
                      type="button"
                      className="picker-crumb"
                      onClick={() => goTo(b.path)}
                    >{b.label}</button>
                  </span>
                ))}
              </div>
              <input
                ref={inputRef}
                className="input picker-filter"
                placeholder="filter…"
                value={filter}
                onChange={e => setFilter(e.target.value)}
              />
            </div>

            {error && <div className="path-hint err" style={{ margin: '12px 18px 0' }}>✗ {error}</div>}

            <div className="picker-list">
              {loading && <div className="picker-empty">Loading…</div>}
              {!loading && visibleEntries.length === 0 && (
                <div className="picker-empty">
                  {filter ? 'No matches' : 'No subdirectories here'}
                </div>
              )}
              {!loading && visibleEntries.map(entry => (
                <button
                  key={entry.name}
                  type="button"
                  className={`picker-row${entry.hidden ? ' hidden' : ''}`}
                  onDoubleClick={() => goTo(joinPath(listing!.path, entry.name))}
                  onClick={() => goTo(joinPath(listing!.path, entry.name))}
                  title={joinPath(listing!.path, entry.name)}
                >
                  <span className="picker-row-icon">▸</span>
                  <span className="picker-row-name">{entry.name}</span>
                </button>
              ))}
              {listing?.truncated && (
                <div className="picker-empty muted" style={{ fontSize: 11 }}>
                  Showing the first 500 entries — narrow with the filter to see more.
                </div>
              )}
            </div>

            <div className="picker-foot">
              <label className="row" style={{ gap: 6, fontSize: 12, color: 'var(--text-2)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={e => setShowHidden(e.target.checked)}
                />
                Show hidden
              </label>
              <span className="spacer" />
              <div className="picker-selected mono" title={listing?.path}>
                {listing?.path ? shortenForDisplay(listing.path, homeHint ?? roots?.home) : '—'}
                {listing?.hasExistingScan && (
                  <span className="chip" style={{ marginLeft: 10, color: 'var(--ok)', borderColor: 'rgba(74,222,128,0.35)' }}>previous scan</span>
                )}
              </div>
              <button className="btn ghost" onClick={onCancel}>Cancel</button>
              <button className="btn primary" onClick={select} disabled={!listing}>
                Select this folder
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function joinPath(parent: string, child: string): string {
  if (parent.endsWith('/') || parent.endsWith('\\')) return parent + child;
  // Use the platform separator inferred from `parent`.
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return parent + sep + child;
}

function buildBreadcrumb(absPath: string, home?: string): Array<{ label: string; path: string }> {
  // Normalize separators for display logic only; the API uses absolute paths.
  const isWin = absPath.includes('\\') && !absPath.startsWith('/');
  const sep = isWin ? '\\' : '/';
  const parts = absPath.split(sep).filter(Boolean);

  // Substitute the home prefix with "~" for prettier breadcrumbs.
  if (home && (absPath === home || absPath.startsWith(home + sep))) {
    const tail = absPath.slice(home.length).split(sep).filter(Boolean);
    const crumbs: Array<{ label: string; path: string }> = [{ label: '~', path: home }];
    let p = home;
    for (const seg of tail) {
      p = p + sep + seg;
      crumbs.push({ label: seg, path: p });
    }
    return crumbs;
  }

  // POSIX absolute: start with "/"
  const crumbs: Array<{ label: string; path: string }> = [];
  if (!isWin) {
    crumbs.push({ label: '/', path: '/' });
    let p = '';
    for (const seg of parts) {
      p = p + '/' + seg;
      crumbs.push({ label: seg, path: p });
    }
    return crumbs;
  }
  // Windows-ish (rare path here)
  let p = '';
  for (const seg of parts) {
    p = p ? p + sep + seg : seg + sep;
    crumbs.push({ label: seg, path: p });
  }
  return crumbs;
}

function shortenForDisplay(p: string, home?: string): string {
  if (!home) return p;
  if (p === home) return '~';
  if (p.startsWith(home + '/') || p.startsWith(home + '\\')) {
    return '~' + p.slice(home.length);
  }
  return p;
}
