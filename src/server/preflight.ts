// Checks for tools the fix-PR agent needs (currently just `gh`).
//
// Returns shape:
//   { ok: true,  version: '2.x' }
//   { ok: false, reason: 'missing' | 'unauthed', detail: string }

import { spawn } from 'node:child_process';

export interface GhStatus {
  installed: boolean;
  authed: boolean;
  version?: string;
  user?: string;
  detail?: string;
}

function run(cmd: string, args: string[], timeoutMs = 5000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }, timeoutMs);
    proc.stdout?.on('data', d => stdout += d.toString());
    proc.stderr?.on('data', d => stderr += d.toString());
    proc.on('error', () => { clearTimeout(t); resolve({ code: 127, stdout, stderr }); });
    proc.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

export async function checkGh(): Promise<GhStatus> {
  // Step 1: is gh installed?
  const v = await run('gh', ['--version']);
  if (v.code !== 0) {
    return { installed: false, authed: false, detail: v.stderr || 'gh CLI not found in PATH' };
  }
  const versionLine = v.stdout.split('\n').find(l => l.includes('gh version')) ?? '';
  const versionMatch = versionLine.match(/gh version\s+(\S+)/);
  const version = versionMatch?.[1];

  // Step 2: is gh authenticated?
  const a = await run('gh', ['auth', 'status']);
  // gh auth status writes to stderr even on success. Combine both for parsing.
  const text = (a.stdout + '\n' + a.stderr).trim();
  if (a.code !== 0) {
    return { installed: true, authed: false, version, detail: text || 'gh is not authenticated' };
  }
  const userMatch = text.match(/Logged in to [^\s]+ (?:as|account) ([^\s)]+)/i);
  return {
    installed: true,
    authed: true,
    version,
    user: userMatch?.[1],
    detail: text,
  };
}
