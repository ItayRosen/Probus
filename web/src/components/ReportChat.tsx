// Chat-with-the-agent view: left side has the original vulnerability report,
// right side is a streaming chat where the agent reads the repo, proposes a
// fix, applies it, and uses `gh` to open the PR.

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

const SUGGESTIONS = [
  'Walk me through the bug, then propose a minimal fix.',
  'Apply the fix and show me the diff.',
  'Open the PR with the fix.',
];

marked.setOptions({ async: false, gfm: true, breaks: false });

export function ReportChat({ slug, reportId, navigate }: Props) {
  const [reportMarkdown, setReportMarkdown] = useState<string>('');
  const [reportName, setReportName] = useState<string>('');
  const [severity, setSeverity] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState<string>('');

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [input, setInput] = useState<string>('');
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

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
      .then(({ turns, status }) => { if (mounted) { setTurns(turns); setStatus(status); } })
      .catch(() => {/* fresh */});
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

  const canSend = useMemo(() => {
    if (status === 'streaming') return false;
    if (!input.trim()) return false;
    return true;
  }, [status, input]);

  const send = useCallback(async (text: string) => {
    setError(null);
    setInput('');
    try {
      await api.chatSend(slug, reportId, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [slug, reportId]);

  const onSubmit = useCallback(() => {
    if (!canSend) return;
    void send(input.trim());
  }, [canSend, input, send]);

  const onStop = useCallback(async () => {
    try { await api.chatAbort(slug, reportId); } catch {/* ignore */}
  }, [slug, reportId]);

  const onReset = useCallback(async () => {
    try { await api.chatReset(slug, reportId); } catch {/* ignore */}
    setTurns([]);
    setStatus('idle');
  }, [slug, reportId]);

  const ghBlocked = gh && (!gh.installed || !gh.authed);

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

      {gh && (
        <GhBanner gh={gh} onRecheck={refreshGh} />
      )}

      <div className="chat-split">
        <aside className="panel chat-context">
          <div className="panel-header">
            <div className="panel-title">Vulnerability report</div>
          </div>
          <div className="chat-context-body">
            <div
              className="markdown"
              style={{ padding: '22px 26px 40px' }}
              dangerouslySetInnerHTML={{ __html: marked.parse(reportMarkdown || '') as string }}
            />
          </div>
        </aside>

        <main className="panel chat-main">
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
            {turns.length === 0 && !error && (
              <div className="chat-empty">
                <div className="chat-empty-title">Let's fix this together</div>
                <div className="chat-empty-sub">
                  The agent has the report context and access to your repo. Start with what you want it to do.
                </div>
                <div className="chat-suggestions">
                  {SUGGESTIONS.map(s => (
                    <button key={s} className="chat-suggestion" onClick={() => { setInput(s); inputRef.current?.focus(); }} disabled={ghBlocked === true && !gh?.installed}>
                      {s}
                    </button>
                  ))}
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
              placeholder={
                ghBlocked && !gh?.installed
                  ? 'Install gh to continue (see above). The chat will work without it but PR creation will fail.'
                  : 'Ask the agent to inspect, fix, or open a PR…'
              }
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
        </main>
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
      // SSE re-broadcasts the transcript on reconnect; dedupe by id.
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
        // Dedupe by tool id.
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

function GhBanner({ gh, onRecheck }: { gh: GhStatus; onRecheck: () => void }) {
  if (gh.installed && gh.authed) {
    return (
      <div className="gh-banner ok">
        <span className="chip dot" style={{ color: 'var(--ok)' }}>
          <span>gh ready{gh.user ? ` · ${gh.user}` : ''}{gh.version ? ` · ${gh.version}` : ''}</span>
        </span>
        <span className="spacer" />
        <button className="btn ghost" onClick={onRecheck}>Recheck</button>
      </div>
    );
  }
  return (
    <div className="gh-banner warn">
      <div className="col" style={{ gap: 6 }}>
        <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>
          {!gh.installed ? 'GitHub CLI (gh) is not installed' : 'GitHub CLI (gh) is not authenticated'}
        </div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.55 }}>
          {!gh.installed ? (
            <>
              The agent uses <span className="mono">gh</span> to create branches, push, and open PRs.
              Install it from <a href="https://cli.github.com" target="_blank" rel="noreferrer">cli.github.com</a> or:
              <div className="mono" style={{ marginTop: 6, color: 'var(--text-1)' }}>
                # macOS<br />
                brew install gh<br />
                <br />
                # Linux (Debian/Ubuntu)<br />
                sudo apt install gh
              </div>
              <div style={{ marginTop: 8 }}>Then authenticate:</div>
              <div className="mono" style={{ marginTop: 4, color: 'var(--text-1)' }}>gh auth login</div>
            </>
          ) : (
            <>
              Run <span className="mono" style={{ color: 'var(--text-1)' }}>gh auth login</span> in your terminal,
              then click Recheck.
            </>
          )}
        </div>
      </div>
      <span className="spacer" />
      <button className="btn primary" onClick={onRecheck}>Recheck</button>
    </div>
  );
}
