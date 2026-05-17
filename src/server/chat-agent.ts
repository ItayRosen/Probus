// Claude Agent SDK wrapper tailored to the chat-fix workflow. Unlike the
// scanner wrapper this one surfaces tool use + tool results in addition to
// text deltas, because the chat UI shows what the agent did (bash commands,
// file edits, gh invocations).

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { resolveProviderConfig } from '../providers.js';

export type ChatAgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-use'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; output: string; isError: boolean }
  | { type: 'usage'; tokens: number }
  | { type: 'done' }
  | { type: 'skipped' }
  | { type: 'error'; text: string };

export interface RunChatAgentOpts {
  prompt: string;
  cwd: string;
  model: string; // provider/slug, e.g. "openrouter/qwen/qwen3.6-plus"
  systemPrompt?: string;
  signal?: AbortSignal;
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try { return JSON.stringify(v); } catch { return String(v); }
}

export async function* runChatAgent(opts: RunChatAgentOpts): AsyncGenerator<ChatAgentEvent> {
  const { prompt, cwd, model, systemPrompt, signal } = opts;

  let runtime;
  try {
    runtime = await resolveProviderConfig(model);
  } catch (err) {
    yield { type: 'error', text: err instanceof Error ? err.message : String(err) };
    return;
  }

  const abortController = new AbortController();
  const onExternalAbort = () => abortController.abort();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const options: Options = {
    cwd,
    model: runtime.modelForSDK,
    env: { ...process.env, ...runtime.env } as Record<string, string | undefined>,
    abortController,
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
    settingSources: [],
    ...(systemPrompt ? { appendSystemPrompt: systemPrompt } : {}),
  };

  const q = query({ prompt, options });

  let outputBaseline = 0;

  try {
    for await (const msg of q) {
      // Streaming deltas — emit text as it arrives so the UI feels live.
      if (msg.type === 'stream_event') {
        const ev = (msg as {
          event?: {
            type?: string;
            delta?: { type?: string; text?: string; thinking?: string };
            message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
            usage?: { output_tokens?: number };
          };
        }).event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          yield { type: 'text-delta', text: ev.delta.text };
        } else if (ev?.type === 'message_start') {
          const u = ev.message?.usage;
          if (u) {
            const input = (u.input_tokens ?? 0)
              + (u.cache_creation_input_tokens ?? 0)
              + (u.cache_read_input_tokens ?? 0);
            if (input > 0) yield { type: 'usage', tokens: input };
            outputBaseline = u.output_tokens ?? 0;
          }
        } else if (ev?.type === 'message_delta') {
          const cumulative = ev.usage?.output_tokens ?? 0;
          const inc = cumulative - outputBaseline;
          if (inc > 0) {
            outputBaseline = cumulative;
            yield { type: 'usage', tokens: inc };
          }
        }
      } else if (msg.type === 'assistant') {
        // Tool calls are surfaced as `tool_use` blocks on the assistant message.
        const blocks = (msg as {
          message?: { content?: Array<{ type?: string; id?: string; name?: string; input?: unknown }> };
        }).message?.content ?? [];
        for (const b of blocks) {
          if (b.type === 'tool_use' && b.id && b.name) {
            yield { type: 'tool-use', id: b.id, name: b.name, input: b.input ?? {} };
          }
        }
      } else if (msg.type === 'user') {
        // The SDK echoes tool results back as a `user` message with
        // `tool_result` blocks. We forward those so the UI can render
        // each tool call → output pair together.
        const blocks = (msg as {
          message?: { content?: Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> };
        }).message?.content ?? [];
        for (const b of blocks) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            const raw = b.content;
            const output = Array.isArray(raw)
              ? raw.map(p => (p && typeof p === 'object' && 'text' in p) ? (p as { text: string }).text : asString(p)).join('')
              : asString(raw);
            yield {
              type: 'tool-result',
              id: b.tool_use_id,
              output: output.length > 8000 ? output.slice(0, 8000) + '\n…(truncated)' : output,
              isError: !!b.is_error,
            };
          }
        }
      } else if (msg.type === 'system') {
        // System-channel errors (e.g. session-mirror failures) are surfaced
        // as a non-fatal error event so the user sees them in the UI.
        const sys = msg as { subtype?: string; error?: string };
        if (sys.subtype === 'mirror_error' && sys.error) {
          yield { type: 'error', text: `system: ${sys.error}` };
        }
      } else if (msg.type === 'result') {
        // SDKResultError exposes real detail in `errors`, `subtype`, etc.
        // Pull every relevant field instead of collapsing it to a generic string.
        const res = msg as {
          subtype?: string;
          is_error?: boolean;
          result?: string;
          errors?: string[];
          permission_denials?: Array<{ tool_name?: string; reason?: string }>;
          stop_reason?: string | null;
          terminal_reason?: { type?: string; reason?: string } | null;
        };
        const ok = res.subtype === 'success' && !res.is_error;
        if (ok) {
          yield { type: 'done' };
          return;
        }

        const lines: string[] = [];
        if (res.subtype && res.subtype !== 'success') lines.push(`exit: ${res.subtype}`);
        if (Array.isArray(res.errors)) {
          for (const e of res.errors) if (e) lines.push(e);
        }
        if (Array.isArray(res.permission_denials)) {
          for (const d of res.permission_denials) {
            lines.push(`permission denied: ${d.tool_name ?? 'unknown'}${d.reason ? ' — ' + d.reason : ''}`);
          }
        }
        if (res.stop_reason) lines.push(`stop_reason: ${res.stop_reason}`);
        if (res.terminal_reason?.reason) lines.push(`terminal: ${res.terminal_reason.reason}`);
        if (res.result) lines.push(res.result);
        if (lines.length === 0) lines.push('agent exited with error (no detail returned by the SDK)');
        yield { type: 'error', text: lines.join('\n') };
        return;
      }
    }

    yield { type: 'done' };
  } catch (err) {
    if (abortController.signal.aborted || (signal?.aborted ?? false)) {
      yield { type: 'skipped' };
      return;
    }
    yield { type: 'error', text: err instanceof Error ? err.message : String(err) };
  } finally {
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}
