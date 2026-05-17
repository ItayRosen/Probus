// Chat-with-the-agent view for a single finding. Layout:
//
//   ┌──────────────────────────────────────┬──────────────┐
//   │  ▸ Vulnerability report (collapsed)  │              │
//   │ ────────────────────────────────────│   gh status  │
//   │                                      │   sidecar    │
//   │  Chat (own fixed height)             │              │
//   │  ┌─────────────────────────────────┐ │              │
//   │  │ messages                        │ │              │
//   │  │                                 │ │              │
//   │  ├─────────────────────────────────┤ │              │
//   │  │ input                           │ │              │
//   │  └─────────────────────────────────┘ │              │
//   └──────────────────────────────────────┴──────────────┘
//
// On first visit (empty transcript) we auto-send a kickoff message so the
// agent gets going without the user having to type anything.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { api, subscribeChat } from '../api.ts';
import type {
  AssistantPart,
  ChatEvent,
  ChatStatus,
  ChatTurn,
  GhStatus,
} from '../types.ts';
import { ToolCallCard } from './ToolCallCard.tsx';

interface Props {
  slug: string;
  reportId: string;
  navigate: (to: string) => void;
}

function kickoffMessage(reportAbsPath: string): string {
  return [
    'Review the vulnerability report at the absolute path below, propose a minimal fix, and open a PR with the change. Walk me through your reasoning as you go.',
    '',
    `Report: ${reportAbsPath}`,
  ].join('\n');
}

marked.setOptions({ async: false, gfm: true, breaks: false });

export function ReportChat({ slug, reportId, navigate }: Props) {
  const [reportMarkdown, setReportMarkdown] = useState<string>('');
  const [reportName, setReportName] = useState<string>('');
  const [severity, setSeverity] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState<string>('');
  const [reportAbsPath, setReportAbsPath] = useState<string>('');

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [input, setInput] = useState<string>('');
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const initialLoadDone = useRef(false);
  const autoSendDone = useRef(false);

  // Bootstrap report + scan metadata so we can show the right context.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [report, scan] = await Promise.all([
          api.scanReport(slug, reportId).catch(() => ({ id: reportId, markdown: '(report not found)' })),
          api.getScan(slug).catch(() => null),
        ]);
        if (!mounted) return;
        setReportMarkdown(report.markdown);
        const meta = scan?.reports.find(r => r.reportId === reportId);
        setReportName(meta?.name ?? reportId);
        setSeverity(meta?.severity ?? null);
        setRepoPath(scan?.metadata?.repoPath ?? '');
        // Build the absolute report path; we keep paths as POSIX-style here
        // since the server normalises and the path comes from /api/scans/:slug.
        if (scan?.outputDir) {
          setReportAbsPath(`${scan.outputDir.replace(/\/$/, '')}/reports/${reportId}`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { mounted = false; };
  }, [slug, reportId]);

  // gh preflight, refreshed when the user clicks "Recheck".
  const refreshGh = useCallback(async () => {
    try { setGh(await api.ghStatus()); } catch { setGh({ installed: false, authed: false, detail: 'preflight failed' }); }
  }, []);
  useEffect(() => { void refreshGh(); }, [refreshGh]);

  // Bootstrap initial chat state.
  useEffect(() => {
    let mounted = true;
    api.chatGet(slug, reportId)
      .then(({ turns, status }) => {
        if (!mounted) return;
        setTurns(turns);
        setStatus(status);
        initialLoadDone.current = true;
      })
      .catch(() => { initialLoadDone.current = true; });
    return () => { mounted = false; };
  }, [slug, reportId]);

  // SSE subscription for live chat events.
  useEffect(() => {
    const unsub = subscribeChat(slug, reportId, (ev: ChatEvent) => {
      setTurns(prev => applyEvent(prev, ev));
      if (ev.type === 'status') setStatus(ev.status);
      if (ev.type === 'error') setError(ev.message);
    });
    return unsub;
  }, [slug, reportId]);

  // Auto-scroll to bottom as turns grow.
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, status]);

  const send = useCallback(async (text: string) => {
    setError(null);
    try {
      await api.chatSend(slug, reportId, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [slug, reportId]);

  // First-visit kickoff: if there's no chat history yet, send a default
  // "review this and open a PR" message — with the absolute report path so
  // the agent can re-read the canonical file at any point.
  useEffect(() => {
    if (autoSendDone.current) return;
    if (!initialLoadDone.current) return;
    if (!reportMarkdown) return;            // wait until the report is loaded
    if (!reportAbsPath) return;             // need the absolute path
    if (status === 'streaming') return;     // already in flight
    if (turns.length > 0) {                 // existing history → skip
      autoSendDone.current = true;
      return;
    }
    autoSendDone.current = true;
    void send(kickoffMessage(reportAbsPath));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportMarkdown, reportAbsPath, status, turns.length, initialLoadDone.current]);

  const canSend = useMemo(() => {
    if (status === 'streaming') return false;
    if (!input.trim()) return false;
    return true;
  }, [status, input]);

  const onSubmit = useCallback(() => {
    if (!canSend) return;
    const text = input.trim();
    setInput('');
    void send(text);
  }, [canSend, input, send]);

  const onStop = useCallback(async () => {
    try { await api.chatAbort(slug, reportId); } catch {/* ignore */}
  }, [slug, reportId]);

  const onReset = useCallback(async () => {
    try { await api.chatReset(slug, reportId); } catch {/* ignore */}
    setTurns([]);
    setStatus('idle');
    // Allow auto-send to fire again for the fresh transcript.
    autoSendDone.current = false;
  }, [slug, reportId]);

  return (
    <div className="fade-in">
      <div className="home-head">
        <div>
          <button type="button" className="btn ghost" onClick={() => navigate(`/scans/${encodeURIComponent(slug)}`)} style={{ marginBottom: 8 }}>
            ← Back to findings
          </button>
          <h1 className="home-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {severity && <span className={`sev ${severity}`}>{severity}</span>}
            <span>Fix → PR</span>
          </h1>
          <div className="home-sub mono" style={{ fontSize: 12 }}>
            {reportName || reportId} · {repoPath || slug}
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {turns.length > 0 && <button className="btn ghost" onClick={onReset}>Reset chat</button>}
        </div>
      </div>

      <div className="chat-layout">
        <div className="chat-main-col">
          <details className="report-collapsible">
            <summary>
              <span className="report-caret">▸</span>
              <span>Vulnerability report</span>
              <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{reportName ? `· ${reportName}` : ''}</span>
              <span className="spacer" />
              <span className="muted" style={{ fontSize: 11 }}>click to expand</span>
            </summary>
            <div className="report-collapsible-body">
              <div
                className="markdown chat-md"
                style={{ padding: '20px 24px 30px' }}
                dangerouslySetInnerHTML={{ __html: marked.parse(reportMarkdown || '') as string }}
              />
            </div>
          </details>

          <section className="chat-panel">
            <div className="panel-header">
              <div className="panel-title">Chat</div>
              <span className="spacer" />
              {status === 'streaming' && (
                <span className="chip dot" style={{ color: 'var(--accent)' }}>
                  <span>thinking…</span>
                </span>
              )}
            </div>

            <div className="chat-messages">
              {turns.length === 0 && status === 'idle' && (
                <div className="chat-empty">
                  <div className="chat-empty-title">Connecting to the agent…</div>
                  <div className="chat-empty-sub">
                    We'll auto-send the first message in a moment. You can type your own follow-ups once it starts.
                  </div>
                </div>
              )}

              {turns.map(turn => (
                <MessageBubble key={turn.id} turn={turn} />
              ))}

              <div ref={listEndRef} />
            </div>

            {error && (
              <div className="error-banner" style={{ margin: '12px 16px', flexShrink: 0 }}>
                <div>
                  <div className="err-title">Agent error</div>
                  <div className="muted">{error}</div>
                </div>
              </div>
            )}

            <div className="chat-input">
              <textarea
                ref={inputRef}
                className="input chat-textarea"
                placeholder="Ask a follow-up — e.g. 'show me the diff before pushing'"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    onSubmit();
                  }
                }}
                rows={3}
                spellCheck={false}
              />
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                <span className="muted" style={{ fontSize: 11 }}>
                  <span className="kbd">Enter</span> to send · <span className="kbd">Shift+Enter</span> for newline
                </span>
                <span className="spacer" />
                {status === 'streaming'
                  ? <button type="button" className="btn danger" onClick={onStop}>Stop</button>
                  : <button type="button" className="btn primary" onClick={onSubmit} disabled={!canSend}>Send →</button>}
              </div>
            </div>
          </section>
        </div>

        <aside className="chat-sidebar">
          <GhSidecar gh={gh} onRecheck={refreshGh} />
        </aside>
      </div>
    </div>
  );
}

function MessageBubble({ turn }: { turn: ChatTurn }) {
  if (turn.role === 'user') {
    const text = turn.parts.map(p => p.kind === 'text' ? p.text : '').join('');
    return (
      <div className="msg user">
        <div className="msg-role">You</div>
        <div className="msg-body">
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{text}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="msg assistant">
      <div className="msg-role">Agent</div>
      <div className="msg-body">
        {turn.parts.map((p, i) => <AssistantPartView key={i} part={p} />)}
      </div>
    </div>
  );
}

function AssistantPartView({ part }: { part: AssistantPart }) {
  if (part.kind === 'text') {
    if (!part.text.trim()) return null;
    return (
      <div
        className="markdown chat-md"
        dangerouslySetInnerHTML={{ __html: marked.parse(part.text) as string }}
      />
    );
  }
  return <ToolCallCard tool={part} />;
}

function applyEvent(prev: ChatTurn[], ev: ChatEvent): ChatTurn[] {
  switch (ev.type) {
    case 'transcript':
      return ev.turns;
    case 'turn-start': {
      if (prev.some(t => t.id === ev.turn.id)) return prev;
      return [...prev, ev.turn];
    }
    case 'text-delta': {
      return prev.map(t => {
        if (t.id !== ev.turnId) return t;
        const next = { ...t, parts: t.parts.slice() };
        const last = next.parts[next.parts.length - 1];
        if (last && last.kind === 'text') {
          next.parts[next.parts.length - 1] = { ...last, text: last.text + ev.text };
        } else {
          next.parts.push({ kind: 'text', text: ev.text });
        }
        return next;
      });
    }
    case 'tool-use': {
      return prev.map(t => {
        if (t.id !== ev.turnId) return t;
        if (t.parts.some(p => p.kind === 'tool' && p.id === ev.tool.id)) return t;
        return { ...t, parts: [...t.parts, { kind: 'tool', id: ev.tool.id, name: ev.tool.name, input: ev.tool.input }] };
      });
    }
    case 'tool-result': {
      return prev.map(t => {
        if (t.id !== ev.turnId) return t;
        return {
          ...t,
          parts: t.parts.map(p =>
            p.kind === 'tool' && p.id === ev.toolId
              ? { ...p, result: ev.result }
              : p,
          ),
        };
      });
    }
    default:
      return prev;
  }
}

function GhSidecar({ gh, onRecheck }: { gh: GhStatus | null; onRecheck: () => void }) {
  return (
    <div className="panel sidecar">
      <div className="panel-header">
        <div className="panel-title">GitHub CLI</div>
        <span className="spacer" />
        {gh && (gh.installed && gh.authed
          ? <span className="chip dot" style={{ color: 'var(--ok)' }}><span>ready</span></span>
          : <span className="chip dot" style={{ color: 'var(--warn)' }}><span>action needed</span></span>)}
      </div>
      <div className="panel-body col" style={{ gap: 12 }}>
        {!gh && <span className="muted" style={{ fontSize: 12 }}>checking…</span>}

        {gh && gh.installed && gh.authed && (
          <>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className="chip dot" style={{ color: 'var(--ok)' }}>
                <span>{gh.user ?? 'authenticated'}</span>
              </span>
              {gh.version && (
                <span className="chip" style={{ fontSize: 10 }}>v{gh.version}</span>
              )}
            </div>
            <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.55 }}>
              The agent will use <span className="mono">gh</span> to branch, commit, push and open the PR.
            </div>
            <button className="btn ghost" onClick={onRecheck}>Recheck</button>
          </>
        )}

        {gh && !gh.installed && (
          <>
            <div style={{ fontSize: 13, color: 'var(--text-0)', fontWeight: 600 }}>gh isn't installed</div>
            <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.55 }}>
              The agent can still review and propose the fix — but it'll need <span className="mono">gh</span> to open the PR.
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-1)', background: 'var(--bg-2)', padding: 8, borderRadius: 6, border: '1px solid var(--border-1)' }}>
              # macOS<br />
              brew install gh<br />
              <br />
              # Debian / Ubuntu<br />
              sudo apt install gh
            </div>
            <div className="muted" style={{ fontSize: 11.5 }}>
              Then run <span className="mono" style={{ color: 'var(--text-1)' }}>gh auth login</span>.
              Docs: <a href="https://cli.github.com" target="_blank" rel="noreferrer">cli.github.com</a>
            </div>
            <button className="btn primary" onClick={onRecheck}>Recheck</button>
          </>
        )}

        {gh && gh.installed && !gh.authed && (
          <>
            <div style={{ fontSize: 13, color: 'var(--text-0)', fontWeight: 600 }}>gh is not authenticated</div>
            <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.55 }}>
              Run in your terminal:
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-1)', background: 'var(--bg-2)', padding: 8, borderRadius: 6, border: '1px solid var(--border-1)' }}>
              gh auth login
            </div>
            <button className="btn primary" onClick={onRecheck}>Recheck</button>
          </>
        )}
      </div>
    </div>
  );
}
