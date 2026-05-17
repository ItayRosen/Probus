// Renders one tool invocation inside an assistant message: the tool name,
// the call's headline parameter (e.g. the file path or the bash command),
// a status pill, and a click-to-expand box with full input + output.

import { useState } from 'react';
import type { AssistantPart } from '../types.ts';

interface Props {
  // tool-shaped part
  tool: Extract<AssistantPart, { kind: 'tool' }>;
}

const TOOL_ICON: Record<string, string> = {
  Bash: '▸',
  Read: '📄',
  Write: '✎',
  Edit: '✎',
  MultiEdit: '✎',
  Grep: '⌕',
  Glob: '⌕',
  Task: '⛁',
};

export function ToolCallCard({ tool }: Props) {
  const [open, setOpen] = useState(false);
  const status: 'pending' | 'ok' | 'err' = !tool.result ? 'pending' : tool.result.isError ? 'err' : 'ok';
  const headline = makeHeadline(tool.name, tool.input);

  return (
    <div className={`tool-card ${status}`}>
      <button type="button" className="tool-head" onClick={() => setOpen(o => !o)}>
        <span className="tool-icon">{TOOL_ICON[tool.name] ?? '▶'}</span>
        <span className="tool-name">{tool.name}</span>
        <span className="tool-headline mono">{headline}</span>
        <span className="spacer" />
        <span className={`tool-status ${status}`}>
          {status === 'pending' ? 'running…' : status === 'err' ? 'failed' : 'done'}
        </span>
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-section">
            <div className="tool-section-label">Input</div>
            <pre className="tool-pre">{formatInput(tool.input)}</pre>
          </div>
          {tool.result && (
            <div className="tool-section">
              <div className="tool-section-label">{tool.result.isError ? 'Error' : 'Output'}</div>
              <pre className={`tool-pre${tool.result.isError ? ' err' : ''}`}>{tool.result.output || '(empty)'}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function makeHeadline(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  // Use the most-useful single field per tool.
  if (name === 'Bash' && typeof o.command === 'string') return truncate(o.command as string, 96);
  if ((name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit') && typeof o.file_path === 'string') return truncate(o.file_path as string, 96);
  if (name === 'Grep' && typeof o.pattern === 'string') return truncate(`/${o.pattern}/`, 96);
  if (name === 'Glob' && typeof o.pattern === 'string') return truncate(o.pattern as string, 96);
  // Fallback: first string-valued field
  for (const [, v] of Object.entries(o)) {
    if (typeof v === 'string') return truncate(v, 96);
  }
  return '';
}

function formatInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try { return JSON.stringify(input, null, 2); } catch { return String(input); }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
