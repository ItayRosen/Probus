// One ChatSession per (scan slug, report id). Each session holds:
//   - the full transcript (user + assistant turns, with tool-use parts inline),
//   - one in-flight agent run at a time,
//   - a set of SSE listeners that get streaming events.
//
// Each user turn = one runChatAgent() call. We synthesize the prompt by
// concatenating the system context (vulnerability report + repo info) with
// the prior transcript. The agent uses Read/Edit/Bash to inspect the repo
// and `gh` to create the PR.

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { runChatAgent } from './chat-agent.js';
import { repoOutputDir } from '../paths.js';
import type { ScanMetadata } from './scans.js';

export type AssistantPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      result?: { output: string; isError: boolean };
    };

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  parts: AssistantPart[];
  timestamp: number;
}

export type ChatEvent =
  | { type: 'transcript'; turns: ChatTurn[]; status: ChatStatus }
  | { type: 'turn-start'; turn: ChatTurn }
  | { type: 'text-delta'; turnId: string; text: string }
  | { type: 'tool-use'; turnId: string; tool: { id: string; name: string; input: unknown } }
  | { type: 'tool-result'; turnId: string; toolId: string; result: { output: string; isError: boolean } }
  | { type: 'turn-end'; turnId: string }
  | { type: 'status'; status: ChatStatus }
  | { type: 'tokens'; tokens: number }
  | { type: 'error'; message: string };

export type ChatStatus = 'idle' | 'streaming' | 'error';

type Listener = (ev: ChatEvent) => void;

let nextId = 1;
const genId = () => `t${Date.now().toString(36)}-${(nextId++).toString(36)}`;

const SYSTEM_PROMPT_TEMPLATE = `
You are a senior security engineer pair-programming with the user to fix a confirmed vulnerability and open a pull request.

<repository>
The repository is at: {{REPO_PATH}}
The vulnerability report markdown lives at: {{REPORT_PATH}}
You have shell access via Bash, plus Read / Write / Edit / Grep / Glob for source files.
</repository>

<vulnerability_report>
{{REPORT_MARKDOWN}}
</vulnerability_report>

<workflow>
1. Inspect the relevant files first (Read/Grep/Glob). Confirm the bug end-to-end.
2. Propose a concrete fix to the user. Keep diffs minimal and focused.
3. When the user agrees, apply the change with Edit/Write.
4. Check git state with \`git status\`. If the repo is dirty with unrelated changes, ASK before staging.
5. Create the PR via the gh CLI:
     a. \`gh auth status\` first. If not authed, STOP and ask the user to run \`gh auth login\`.
     b. \`git checkout -b fix/<short-slug>\`
     c. \`git add <only the files you changed>\`
     d. \`git commit -m "fix(security): <short imperative title>"\` with a body explaining the bug + fix.
     e. \`git push -u origin HEAD\`
     f. \`gh pr create --fill --title "<title>" --body "<markdown body>"\` — body should explain the vuln, the attack path, and the remediation.
6. Return the PR URL.
</workflow>

<style>
- Be concise. Avoid restating the report; the user already saw it.
- Prefer running shell commands over describing them.
- Don't push without confirming with the user when the diff is non-trivial.
- If gh isn't installed, tell the user how to install it (brew install gh on mac; see https://cli.github.com).
</style>
`.trim();

export interface StartChatOpts {
  slug: string;
  reportId: string;
  reportMarkdown: string;
  reportPath: string;
  repoPath: string;
  model: string;
}

export class ChatSession {
  readonly key: string;
  readonly slug: string;
  readonly reportId: string;
  readonly reportMarkdown: string;
  readonly reportPath: string;
  readonly repoPath: string;
  readonly model: string;
  readonly systemPrompt: string;

  private transcript: ChatTurn[] = [];
  private status: ChatStatus = 'idle';
  private listeners = new Set<Listener>();
  private abortCtrl: AbortController | null = null;

  constructor(opts: StartChatOpts) {
    this.key = `${opts.slug}::${opts.reportId}`;
    this.slug = opts.slug;
    this.reportId = opts.reportId;
    this.reportMarkdown = opts.reportMarkdown;
    this.reportPath = opts.reportPath;
    this.repoPath = opts.repoPath;
    this.model = opts.model;
    this.systemPrompt = SYSTEM_PROMPT_TEMPLATE
      .replace('{{REPO_PATH}}', opts.repoPath)
      .replace('{{REPORT_PATH}}', opts.reportPath)
      .replace('{{REPORT_MARKDOWN}}', opts.reportMarkdown);
  }

  // ----- public -----

  snapshot(): { turns: ChatTurn[]; status: ChatStatus } {
    return { turns: this.transcript, status: this.status };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn({ type: 'transcript', turns: this.transcript, status: this.status });
    return () => this.listeners.delete(fn);
  }

  async sendMessage(text: string): Promise<void> {
    if (this.status === 'streaming') {
      throw new Error('Agent is still responding. Wait for it to finish or click Stop.');
    }
    const userTurn: ChatTurn = {
      id: genId(),
      role: 'user',
      parts: [{ kind: 'text', text }],
      timestamp: Date.now(),
    };
    this.transcript.push(userTurn);
    this.emit({ type: 'turn-start', turn: userTurn });
    void this.runAgent();
  }

  abort(): void {
    this.abortCtrl?.abort();
  }

  resetTranscript(): void {
    this.abort();
    this.transcript = [];
    this.setStatus('idle');
    this.emit({ type: 'transcript', turns: this.transcript, status: this.status });
  }

  // ----- internals -----

  private emit(ev: ChatEvent): void {
    for (const fn of this.listeners) {
      try { fn(ev); } catch { /* swallow listener errors */ }
    }
  }

  private setStatus(s: ChatStatus): void {
    this.status = s;
    this.emit({ type: 'status', status: s });
  }

  /**
   * Surface an agent error in two places at once:
   *   1. Inline in the assistant turn as a text part — so the error sticks
   *      around in chat history and is preserved across resets/scrolls.
   *   2. As a separate `error` event so the UI can also show its banner.
   */
  private recordError(turn: ChatTurn, message: string): void {
    const block = `\n\n> ⚠️ **Agent error**\n>\n${message
      .split('\n')
      .map(l => `> ${l}`)
      .join('\n')}\n`;
    const last = turn.parts[turn.parts.length - 1];
    if (last && last.kind === 'text') {
      last.text += block;
    } else {
      turn.parts.push({ kind: 'text', text: block });
    }
    // Stream to live clients via the existing text-delta path so they see
    // it without needing to refetch the snapshot.
    this.emit({ type: 'text-delta', turnId: turn.id, text: block });
    this.emit({ type: 'error', message });
  }

  private buildPrompt(): string {
    // We pass the prior transcript as part of the prompt so the agent has
    // continuity across turns. Tool-result outputs are summarized rather
    // than re-injected verbatim to keep token usage sane.
    const lines: string[] = [];
    for (const turn of this.transcript) {
      if (turn.role === 'user') {
        const text = turn.parts.map(p => p.kind === 'text' ? p.text : '').join('');
        lines.push(`# User\n${text}\n`);
      } else {
        const parts: string[] = [];
        for (const p of turn.parts) {
          if (p.kind === 'text') parts.push(p.text);
          else {
            const inp = (() => { try { return JSON.stringify(p.input).slice(0, 400); } catch { return ''; } })();
            const out = p.result?.output ?? '';
            parts.push(
              `[tool ${p.name}(${inp})${p.result?.isError ? ' ERROR' : ''}]\n` +
              (out ? `${out.slice(0, 800)}${out.length > 800 ? '…' : ''}` : '(pending)'),
            );
          }
        }
        lines.push(`# Assistant\n${parts.join('\n')}\n`);
      }
    }
    // The last user turn's text is implied as the *current* request; the
    // agent will read everything above it as context.
    return lines.join('\n');
  }

  private async runAgent(): Promise<void> {
    this.setStatus('streaming');
    this.abortCtrl = new AbortController();

    const assistantTurn: ChatTurn = {
      id: genId(),
      role: 'assistant',
      parts: [],
      timestamp: Date.now(),
    };
    this.transcript.push(assistantTurn);
    this.emit({ type: 'turn-start', turn: assistantTurn });

    // Map tool_use id → index of part in assistantTurn.parts (for fast lookup
    // when the matching tool_result arrives).
    const toolIdx = new Map<string, number>();
    let textBuf = ''; // streaming text gets accumulated into a single text part

    const ensureTextPart = (): { kind: 'text'; text: string } => {
      const last = assistantTurn.parts[assistantTurn.parts.length - 1];
      if (last && last.kind === 'text') return last as { kind: 'text'; text: string };
      const fresh: AssistantPart = { kind: 'text', text: '' };
      assistantTurn.parts.push(fresh);
      return fresh as { kind: 'text'; text: string };
    };

    try {
      const prompt = this.buildPrompt();
      for await (const ev of runChatAgent({
        prompt,
        cwd: this.repoPath,
        model: this.model,
        systemPrompt: this.systemPrompt,
        signal: this.abortCtrl.signal,
      })) {
        if (ev.type === 'text-delta') {
          textBuf += ev.text;
          const part = ensureTextPart();
          part.text += ev.text;
          this.emit({ type: 'text-delta', turnId: assistantTurn.id, text: ev.text });
        } else if (ev.type === 'tool-use') {
          // Flush any in-progress text so the order is preserved.
          textBuf = '';
          const part: AssistantPart = { kind: 'tool', id: ev.id, name: ev.name, input: ev.input };
          assistantTurn.parts.push(part);
          toolIdx.set(ev.id, assistantTurn.parts.length - 1);
          this.emit({ type: 'tool-use', turnId: assistantTurn.id, tool: { id: ev.id, name: ev.name, input: ev.input } });
        } else if (ev.type === 'tool-result') {
          const idx = toolIdx.get(ev.id);
          if (idx !== undefined) {
            const p = assistantTurn.parts[idx];
            if (p?.kind === 'tool') {
              p.result = { output: ev.output, isError: ev.isError };
            }
          }
          this.emit({ type: 'tool-result', turnId: assistantTurn.id, toolId: ev.id, result: { output: ev.output, isError: ev.isError } });
        } else if (ev.type === 'usage') {
          this.emit({ type: 'tokens', tokens: ev.tokens });
        } else if (ev.type === 'error') {
          this.recordError(assistantTurn, ev.text);
        } else if (ev.type === 'skipped') {
          // user-initiated abort — leave the partial turn as-is, go idle
          break;
        }
      }
    } catch (err) {
      this.recordError(assistantTurn, err instanceof Error ? err.message : String(err));
    } finally {
      this.abortCtrl = null;
      this.emit({ type: 'turn-end', turnId: assistantTurn.id });
      this.setStatus('idle');
    }
  }
}

export class ChatRegistry {
  private sessions = new Map<string, ChatSession>();

  // Looks up the scan's metadata to figure out repoPath and which model to use.
  // Returns null if the scan or report can't be found.
  getOrCreate(opts: {
    slug: string;
    reportId: string;
  }): ChatSession | null {
    const key = `${opts.slug}::${opts.reportId}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const outputDir = repoOutputDir(opts.slug);
    const metaPath = path.join(outputDir, 'metadata.json');
    if (!existsSync(metaPath)) return null;
    let meta: ScanMetadata;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8')) as ScanMetadata;
    } catch { return null; }

    const reportPath = path.join(outputDir, 'reports', opts.reportId);
    if (!existsSync(reportPath)) return null;
    const reportMarkdown = readFileSync(reportPath, 'utf8');

    // PR creation runs on the secondary (verifier) model. That's the
    // stronger one in each provider's default lineup — fixing real code and
    // opening a PR is higher-stakes than the per-file scan, so we want the
    // smarter model here regardless of whether the user customized primary.
    // Only fall back to primary if no secondary was recorded for the scan.
    const model = meta.secondaryModel || meta.primaryModel;
    if (!model) return null;
    if (!meta.repoPath) return null;
    if (!meta.secondaryModel && meta.primaryModel) {
      console.warn(
        `[chat] no secondary model recorded for scan ${opts.slug}; ` +
        `falling back to primary (${meta.primaryModel}).`,
      );
    } else {
      console.log(`[chat] starting fix session for ${opts.slug}/${opts.reportId} on ${model}`);
    }

    const session = new ChatSession({
      slug: opts.slug,
      reportId: opts.reportId,
      reportMarkdown,
      reportPath,
      repoPath: meta.repoPath,
      model,
    });
    this.sessions.set(key, session);
    return session;
  }

  get(slug: string, reportId: string): ChatSession | null {
    return this.sessions.get(`${slug}::${reportId}`) ?? null;
  }

  drop(slug: string, reportId: string): void {
    const s = this.sessions.get(`${slug}::${reportId}`);
    if (s) {
      s.abort();
      this.sessions.delete(`${slug}::${reportId}`);
    }
  }
}
