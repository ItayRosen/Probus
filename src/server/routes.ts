// Express routes for the probus web UI.
//
// The CLI no longer takes a target repo — everything is driven from the page.
//
//   GET    /api/config            — provider list + key state + env file path + home/cwd
//   POST   /api/keys              — persist a provider API key
//   POST   /api/validate-repo     — resolve and check a user-typed repo path
//   GET    /api/fs/roots          — common quick-access dirs (home, Desktop, ...)
//   GET    /api/fs/list?path=...  — list directories under a path (filesystem picker)
//
//   GET    /api/scans             — list every past scan (from output/)
//   POST   /api/scans             — start a new scan (only one active at a time)
//   GET    /api/active            — { slug } of the currently active scan, if any
//
//   GET    /api/scans/:slug       — scan metadata + reports (works for past or live)
//   GET    /api/scans/:slug/state — live in-memory state (404 if not active)
//   GET    /api/scans/:slug/events— SSE stream (404 if not active)
//   POST   /api/scans/:slug/abort
//   POST   /api/scans/:slug/skip  — { index }
//   GET    /api/scans/:slug/reports
//   GET    /api/scans/:slug/reports/:id
//
//   GET    /api/preflight/gh     — is the gh CLI installed + authenticated?
//   GET    /api/chat/:slug/:id   — chat transcript snapshot
//   GET    /api/chat/:slug/:id/events — SSE stream of chat events
//   POST   /api/chat/:slug/:id/messages — body: { text } — send a turn
//   POST   /api/chat/:slug/:id/abort    — stop in-flight agent run
//   POST   /api/chat/:slug/:id/reset    — drop transcript and start over

import express from 'express';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultModels,
  detectProvider,
  envVarForProvider,
  type KnownProvider,
} from '../providers.js';
import { saveKey, ENV_FILE } from '../env.js';
import { listVerifiedReports } from '../scanner.js';
import { repoOutputDir, repoSlugFor } from '../paths.js';
import {
  ScanConflictError,
  ScanRegistry,
  listPastScans,
} from './scans.js';
import { ChatRegistry } from './chat.js';
import { checkGh } from './preflight.js';

const ALL_PROVIDERS: KnownProvider[] = ['openrouter', 'openai', 'anthropic'];

const PROVIDER_LABEL: Record<KnownProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);
const MAX_PARALLEL = 16;

function providersPayload() {
  const detected = detectProvider();
  return {
    detected,
    envFile: ENV_FILE,
    home: os.homedir(),
    cwd: process.cwd(),
    providers: ALL_PROVIDERS.map(id => ({
      id,
      label: PROVIDER_LABEL[id],
      envVar: envVarForProvider(id),
      hasKey: !!process.env[envVarForProvider(id)],
      defaults: defaultModels(id),
    })),
  };
}

// ---------- filesystem picker helpers ----------

function expandUser(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const MAX_FS_ENTRIES = 500;

function listDirSafe(absPath: string): {
  entries: Array<{ name: string; isDir: boolean; hidden: boolean }>;
  truncated: boolean;
} {
  let names: string[];
  try {
    names = readdirSync(absPath);
  } catch (err) {
    throw new Error(`Could not read directory: ${err instanceof Error ? err.message : String(err)}`);
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const truncated = names.length > MAX_FS_ENTRIES;
  if (truncated) names = names.slice(0, MAX_FS_ENTRIES);

  const entries: Array<{ name: string; isDir: boolean; hidden: boolean }> = [];
  for (const name of names) {
    let isDir = false;
    try {
      // statSync follows symlinks; lstatSync wouldn't. We want symlinked
      // dirs to appear as dirs since that's the user's mental model.
      const st = statSync(path.join(absPath, name));
      isDir = st.isDirectory();
    } catch {
      // Permission denied / dangling symlink — skip.
      continue;
    }
    entries.push({ name, isDir, hidden: name.startsWith('.') });
  }
  // Show directories first, then files.
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir));
  return { entries, truncated };
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function createApiRouter(): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  const registry = new ScanRegistry();
  const chat = new ChatRegistry();

  // ----- config / setup -----

  router.get('/config', (_req, res) => {
    res.json(providersPayload());
  });

  router.post('/keys', (req, res) => {
    const { provider, key } = req.body as { provider?: string; key?: string };
    if (!provider || typeof provider !== 'string' || !ALL_PROVIDERS.includes(provider as KnownProvider)) {
      return res.status(400).json({ error: 'Invalid provider' });
    }
    const trimmed = (key ?? '').trim();
    if (!trimmed) return res.status(400).json({ error: 'Key cannot be empty' });
    try {
      const envVar = envVarForProvider(provider);
      saveKey(envVar, trimmed);
      res.json({ ok: true, envVar });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/validate-repo', (req, res) => {
    const raw = (req.body as { path?: unknown }).path;
    if (typeof raw !== 'string' || !raw.trim()) {
      return res.status(400).json({ error: 'Repo path is required' });
    }
    const abs = path.resolve(expandUser(raw.trim()));
    if (!existsSync(abs)) return res.status(404).json({ error: `Path not found: ${abs}` });
    let st;
    try { st = statSync(abs); }
    catch (err) { return res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    if (!st.isDirectory()) return res.status(400).json({ error: 'Path is not a directory' });
    const slug = repoSlugFor(abs);
    const outputDir = repoOutputDir(slug);
    res.json({
      absolutePath: abs,
      slug,
      outputDir,
      hasExistingScan: existsSync(outputDir),
    });
  });

  // ----- filesystem picker -----

  router.get('/fs/roots', (_req, res) => {
    const home = os.homedir();
    const cwd = process.cwd();
    // Build a list of well-known starting points, keeping only those that exist.
    const candidates: Array<{ label: string; path: string }> = [
      { label: 'Home',      path: home },
      { label: 'Desktop',   path: path.join(home, 'Desktop') },
      { label: 'Documents', path: path.join(home, 'Documents') },
      { label: 'Downloads', path: path.join(home, 'Downloads') },
      { label: 'Code',      path: path.join(home, 'Code') },
      { label: 'Projects',  path: path.join(home, 'Projects') },
      { label: 'Developer', path: path.join(home, 'Developer') },
      { label: 'src',       path: path.join(home, 'src') },
    ];
    const roots = candidates.filter(c => {
      try { return statSync(c.path).isDirectory(); } catch { return false; }
    });
    // Always include cwd if it's outside the home tree.
    if (!cwd.startsWith(home + path.sep) && cwd !== home) {
      roots.push({ label: 'Current dir', path: cwd });
    }
    res.json({ home, cwd, roots });
  });

  router.get('/fs/list', (req, res) => {
    const raw = typeof req.query.path === 'string' ? req.query.path : '';
    const target = raw ? path.resolve(expandUser(raw)) : os.homedir();
    if (!existsSync(target)) return res.status(404).json({ error: `Path not found: ${target}` });
    let st;
    try { st = statSync(target); }
    catch (err) { return res.status(403).json({ error: err instanceof Error ? err.message : String(err) }); }
    if (!st.isDirectory()) return res.status(400).json({ error: 'Path is not a directory' });

    try {
      const { entries, truncated } = listDirSafe(target);
      const parent = path.dirname(target);
      res.json({
        path: target,
        parent: parent === target ? null : parent, // null at filesystem root
        entries,
        truncated,
        slug: repoSlugFor(target),
        hasExistingScan: existsSync(repoOutputDir(repoSlugFor(target))),
      });
    } catch (err) {
      res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ----- scans -----

  router.get('/scans', (_req, res) => {
    const active = registry.getActive();
    const past = listPastScans();
    const list = past.map(s => ({
      ...s,
      isActive: active?.slug === s.slug && active.isRunning,
    }));
    res.json({ scans: list, activeSlug: active?.slug ?? null });
  });

  router.get('/active', (_req, res) => {
    const a = registry.getActive();
    res.json({ slug: a?.slug ?? null, isRunning: !!a?.isRunning });
  });

  router.post('/scans', (req, res) => {
    const body = (req.body ?? {}) as Partial<{
      repoPath: string;
      provider: KnownProvider;
      primaryModel: string;
      secondaryModel: string;
      effort: 'low' | 'medium' | 'high';
      parallel: number;
    }>;

    if (typeof body.repoPath !== 'string' || !body.repoPath.trim()) {
      return res.status(400).json({ error: 'repoPath is required' });
    }
    const repoAbs = path.resolve(body.repoPath);
    if (!existsSync(repoAbs)) return res.status(400).json({ error: `Path not found: ${repoAbs}` });
    if (!statSync(repoAbs).isDirectory()) return res.status(400).json({ error: 'Path is not a directory' });

    const provider = body.provider ?? detectProvider();
    if (!provider || !ALL_PROVIDERS.includes(provider as KnownProvider)) {
      return res.status(400).json({ error: 'A provider is required' });
    }
    const envVar = envVarForProvider(provider);
    if (!process.env[envVar]) {
      return res.status(412).json({ error: 'Missing API key for provider', provider, envVar });
    }

    const defaults = defaultModels(provider);
    const primaryModel = body.primaryModel?.trim() || defaults.primary;
    const secondaryModel = body.secondaryModel?.trim() || defaults.secondary;
    const effort = (body.effort && EFFORTS.has(body.effort)) ? body.effort : 'low';
    const parallel = Number.isFinite(body.parallel) && (body.parallel as number) >= 1 && (body.parallel as number) <= MAX_PARALLEL
      ? Math.floor(body.parallel as number)
      : 1;

    try {
      const runner = registry.start({
        targetRepo: repoAbs,
        primaryModel,
        secondaryModel,
        provider,
        effort,
        parallel,
      });
      res.json({ ok: true, slug: runner.slug, state: runner.snapshot });
    } catch (err) {
      if (err instanceof ScanConflictError) {
        return res.status(409).json({ error: err.message, activeSlug: err.activeSlug });
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ----- per-scan -----

  router.get('/scans/:slug', (req, res) => {
    const slug = req.params.slug;
    const outputDir = repoOutputDir(slug);
    if (!existsSync(outputDir)) return res.status(404).json({ error: 'Unknown scan' });

    let metadata: unknown = null;
    const metaPath = path.join(outputDir, 'metadata.json');
    if (existsSync(metaPath)) {
      try { metadata = JSON.parse(readFileSync(metaPath, 'utf8')); }
      catch { metadata = null; }
    }
    const runner = registry.getBySlug(slug);
    const reports = existsSync(outputDir) ? listVerifiedReports(outputDir).map(r => ({
      file: r.file,
      name: r.name,
      severity: r.severity,
      description: r.description,
      reason: r.reason,
      reportId: path.basename(r.reportPath),
    })) : [];
    reports.sort((a, b) => {
      const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      return (order[a.severity] - order[b.severity]) || a.file.localeCompare(b.file);
    });
    res.json({
      slug,
      outputDir,
      metadata,
      state: runner?.snapshot ?? null,
      isActive: !!runner,
      isRunning: !!runner?.isRunning,
      reports,
    });
  });

  router.get('/scans/:slug/state', (req, res) => {
    const runner = registry.getBySlug(req.params.slug);
    if (!runner) return res.status(404).json({ error: 'No active scan for this slug' });
    res.json({ state: runner.snapshot });
  });

  router.get('/scans/:slug/events', (req, res) => {
    const runner = registry.getBySlug(req.params.slug);
    if (!runner) return res.status(404).json({ error: 'No active scan for this slug' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (data: unknown) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* connection closed */ }
    };

    const unsubscribe = runner.subscribe(send);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.post('/scans/:slug/abort', (req, res) => {
    const runner = registry.getBySlug(req.params.slug);
    if (!runner) return res.status(404).json({ error: 'No active scan for this slug' });
    runner.abort();
    res.json({ ok: true });
  });

  router.post('/scans/:slug/skip', (req, res) => {
    const runner = registry.getBySlug(req.params.slug);
    if (!runner) return res.status(404).json({ error: 'No active scan for this slug' });
    const idx = Number((req.body as { index?: unknown }).index);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Invalid index' });
    const ok = runner.skipFile(idx);
    if (!ok) return res.status(404).json({ error: 'No abortable in-flight file at that index' });
    res.json({ ok: true });
  });

  router.get('/scans/:slug/reports', (req, res) => {
    const slug = req.params.slug;
    const outputDir = repoOutputDir(slug);
    if (!existsSync(outputDir)) return res.json({ reports: [], outputDir, exists: false });
    const reports = listVerifiedReports(outputDir).map(r => ({
      file: r.file,
      name: r.name,
      severity: r.severity,
      description: r.description,
      reason: r.reason,
      reportId: path.basename(r.reportPath),
    }));
    reports.sort((a, b) => {
      const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      return (order[a.severity] - order[b.severity]) || a.file.localeCompare(b.file);
    });
    res.json({ reports, outputDir, exists: true });
  });

  router.get('/scans/:slug/reports/:id', (req, res) => {
    const slug = req.params.slug;
    const id = req.params.id;
    if (!/^[a-zA-Z0-9._-]+\.md$/.test(id)) {
      return res.status(400).json({ error: 'Invalid report id' });
    }
    const outputDir = repoOutputDir(slug);
    const reportsRoot = path.join(outputDir, 'reports');
    const reportPath = path.join(reportsRoot, id);
    // Defense-in-depth: ensure path resolves inside the reports dir.
    if (!isInside(reportsRoot, reportPath)) {
      return res.status(400).json({ error: 'Invalid report path' });
    }
    if (!existsSync(reportPath)) return res.status(404).json({ error: 'Report not found' });
    const markdown = readFileSync(reportPath, 'utf8');
    res.json({ id, markdown });
  });

  // ----- preflight -----

  router.get('/preflight/gh', async (_req, res) => {
    try {
      const status = await checkGh();
      res.json(status);
    } catch (err) {
      res.status(500).json({ installed: false, authed: false, detail: err instanceof Error ? err.message : String(err) });
    }
  });

  // ----- chat -----

  const validId = (s: string) => /^[a-zA-Z0-9._-]+$/.test(s);

  router.get('/chat/:slug/:id', (req, res) => {
    const { slug, id } = req.params;
    if (!validId(slug) || !validId(id)) return res.status(400).json({ error: 'Invalid id' });
    const session = chat.get(slug, id);
    if (!session) return res.json({ turns: [], status: 'idle', exists: false });
    const snap = session.snapshot();
    res.json({ ...snap, exists: true });
  });

  router.get('/chat/:slug/:id/events', (req, res) => {
    const { slug, id } = req.params;
    if (!validId(slug) || !validId(id)) return res.status(400).json({ error: 'Invalid id' });
    const session = chat.getOrCreate({ slug, reportId: id });
    if (!session) return res.status(404).json({ error: 'Scan or report not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (data: unknown) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* connection closed */ }
    };
    const unsubscribe = session.subscribe(send);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.post('/chat/:slug/:id/messages', async (req, res) => {
    const { slug, id } = req.params;
    if (!validId(slug) || !validId(id)) return res.status(400).json({ error: 'Invalid id' });
    const text = (req.body as { text?: unknown }).text;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    const session = chat.getOrCreate({ slug, reportId: id });
    if (!session) return res.status(404).json({ error: 'Scan or report not found' });
    try {
      await session.sendMessage(text.trim());
      res.json({ ok: true });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/chat/:slug/:id/abort', (req, res) => {
    const { slug, id } = req.params;
    if (!validId(slug) || !validId(id)) return res.status(400).json({ error: 'Invalid id' });
    const session = chat.get(slug, id);
    if (!session) return res.status(404).json({ error: 'No chat session' });
    session.abort();
    res.json({ ok: true });
  });

  router.post('/chat/:slug/:id/reset', (req, res) => {
    const { slug, id } = req.params;
    if (!validId(slug) || !validId(id)) return res.status(400).json({ error: 'Invalid id' });
    const session = chat.get(slug, id);
    if (!session) return res.json({ ok: true });
    session.resetTranscript();
    res.json({ ok: true });
  });

  return router;
}
