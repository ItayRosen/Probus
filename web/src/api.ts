// Thin fetch wrappers around /api endpoints + an SSE subscription helper.

import type {
  ChatEvent,
  ChatStatus,
  ChatTurn,
  ConfigPayload,
  FsListResponse,
  FsRootsResponse,
  GhStatus,
  KnownProvider,
  PastScanSummary,
  ReportSummary,
  ScanDetailResponse,
  ScanState,
  ServerEvent,
  ValidateRepoResponse,
} from './types.ts';

async function json<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = '';
    let data: { error?: string; activeSlug?: string; provider?: string; envVar?: string } | null = null;
    try { data = await res.json(); detail = data?.error ?? ''; } catch { /* ignore */ }
    const err = new Error(detail || `${res.status} ${res.statusText}`) as Error & { status?: number; data?: unknown };
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return res.json() as Promise<T>;
}

export const api = {
  config: () => json<ConfigPayload>('/api/config'),
  saveKey: (provider: KnownProvider, key: string) =>
    json<{ ok: true; envVar: string }>('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ provider, key }),
    }),
  validateRepo: (path: string) =>
    json<ValidateRepoResponse>('/api/validate-repo', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  fsRoots: () => json<FsRootsResponse>('/api/fs/roots'),
  fsList: (path?: string) =>
    json<FsListResponse>(
      path
        ? `/api/fs/list?path=${encodeURIComponent(path)}`
        : '/api/fs/list',
    ),

  ghStatus: () => json<GhStatus>('/api/preflight/gh'),

  chatGet: (slug: string, id: string) =>
    json<{ turns: ChatTurn[]; status: ChatStatus; exists: boolean }>(
      `/api/chat/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`,
    ),
  chatSend: (slug: string, id: string, text: string) =>
    json<{ ok: true }>(`/api/chat/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  chatAbort: (slug: string, id: string) =>
    json<{ ok: true }>(`/api/chat/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/abort`, { method: 'POST' }),
  chatReset: (slug: string, id: string) =>
    json<{ ok: true }>(`/api/chat/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/reset`, { method: 'POST' }),

  listScans: () => json<{ scans: PastScanSummary[]; activeSlug: string | null }>('/api/scans'),
  active: () => json<{ slug: string | null; isRunning: boolean }>('/api/active'),

  startScan: (opts: {
    repoPath: string;
    provider: KnownProvider;
    primaryModel?: string;
    secondaryModel?: string;
    effort?: 'low' | 'medium' | 'high';
    parallel?: number;
  }) =>
    json<{ ok: true; slug: string; state: ScanState }>('/api/scans', {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  getScan: (slug: string) => json<ScanDetailResponse>(`/api/scans/${encodeURIComponent(slug)}`),
  scanState: (slug: string) => json<{ state: ScanState }>(`/api/scans/${encodeURIComponent(slug)}/state`),
  scanReports: (slug: string) =>
    json<{ reports: ReportSummary[]; outputDir: string; exists: boolean }>(
      `/api/scans/${encodeURIComponent(slug)}/reports`,
    ),
  scanReport: (slug: string, id: string) =>
    json<{ id: string; markdown: string }>(
      `/api/scans/${encodeURIComponent(slug)}/reports/${encodeURIComponent(id)}`,
    ),

  abortScan: (slug: string) =>
    json<{ ok: true }>(`/api/scans/${encodeURIComponent(slug)}/abort`, { method: 'POST' }),
  skipFile: (slug: string, index: number) =>
    json<{ ok: true }>(`/api/scans/${encodeURIComponent(slug)}/skip`, {
      method: 'POST',
      body: JSON.stringify({ index }),
    }),
};

export function subscribeEvents(slug: string, onEvent: (ev: ServerEvent) => void): () => void {
  const es = new EventSource(`/api/scans/${encodeURIComponent(slug)}/events`);
  es.onmessage = e => {
    try { onEvent(JSON.parse(e.data) as ServerEvent); } catch { /* ignore */ }
  };
  es.onerror = () => {
    // Browser will auto-reconnect; nothing more to do. If the scan has
    // ended, the server returns 404 on reconnect and the EventSource will
    // keep retrying — callers should close it themselves when appropriate.
  };
  return () => es.close();
}

export function subscribeChat(slug: string, id: string, onEvent: (ev: ChatEvent) => void): () => void {
  const es = new EventSource(`/api/chat/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/events`);
  es.onmessage = e => {
    try { onEvent(JSON.parse(e.data) as ChatEvent); } catch { /* ignore */ }
  };
  return () => es.close();
}
