// ScanRegistry + ScanRunner.
//
// ScanRunner owns one analyst → researcher → QA run in memory, emits
// ServerEvents to SSE subscribers, and persists progress to:
//   output/<slug>/metadata.json  ← run config + status
//   output/<slug>/findings/*     ← (written by scanner.ts via per-file pipeline)
//   output/<slug>/reports/*.md   ← (written by QA agent)
//
// ScanRegistry holds at most one *active* runner. Past scans live on disk
// and are reconstructed via listPastScans() when the UI loads the home page.

import path from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import {
  ensureOutputDir,
  isCached,
  markCached,
  listVerifiedReports,
  runAnalyst,
  scanAndVerify,
} from '../scanner.js';
import { repoOutputDir, repoSlugFor, PACKAGE_ROOT } from '../paths.js';
import type { KnownProvider } from '../providers.js';
import type {
  FileEntry,
  FileStatus,
  ScanPhase,
  ScanState,
  ServerEvent,
} from './events.js';

export const EFFORT_FILE_LIMIT: Record<'low' | 'medium' | 'high', number> = {
  low: 50,
  medium: 100,
  high: 500,
};

export interface ScanStartOpts {
  targetRepo: string;
  primaryModel: string;
  secondaryModel: string;
  provider: KnownProvider;
  effort: 'low' | 'medium' | 'high';
  parallel: number;
}

export interface ScanMetadata {
  slug: string;
  repoPath: string;
  primaryModel: string;
  secondaryModel: string;
  provider: KnownProvider;
  effort: 'low' | 'medium' | 'high';
  parallel: number;
  startedAt: number;
  lastUpdatedAt: number;
  status: 'running' | 'completed' | 'aborted' | 'error';
}

export interface PastScanSummary extends ScanMetadata {
  fileCount: number;
  verifiedCount: number;
  candidateCount: number;
  isActive: boolean;
  errorMessage?: string;
}

type Listener = (ev: ServerEvent) => void;

export class ScanRunner {
  private state: ScanState;
  private listeners = new Set<Listener>();
  private fileAborts = new Map<number, AbortController>();
  private rootAbort: AbortController | null = null;
  private cacheFile = '';
  private outputDir = '';
  private running = false;
  private startedAt: number;

  constructor(opts: ScanStartOpts) {
    const repoPath = path.resolve(opts.targetRepo);
    const slug = repoSlugFor(repoPath);
    this.startedAt = Date.now();
    this.state = {
      phase: 'idle',
      targetRepo: opts.targetRepo,
      repoSlug: slug,
      primaryModel: opts.primaryModel,
      secondaryModel: opts.secondaryModel,
      provider: opts.provider,
      effort: opts.effort,
      parallel: opts.parallel,
      files: [],
      analystThought: '',
      tokens: 0,
      resumedFindings: 0,
      fatalError: null,
      startedAt: this.startedAt,
    };
    this.outputDir = repoOutputDir(slug);
    this.cacheFile = path.join(this.outputDir, 'processed-files.txt');
  }

  // --- public surface ---

  get snapshot(): ScanState { return this.state; }
  get slug(): string { return this.state.repoSlug; }
  get repoOutputDir(): string { return this.outputDir; }
  get isRunning(): boolean {
    return this.state.phase === 'analyst' || this.state.phase === 'scanning';
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    // Send snapshot first so newcomers don't have to ask separately.
    fn({ type: 'snapshot', state: this.state });
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.writeMetadata('running');
    this.run().catch(err => {
      this.state.fatalError = err instanceof Error ? err.message : String(err);
      this.setPhase('error');
      this.writeMetadata('error');
      this.emit({ type: 'error', message: this.state.fatalError });
    });
  }

  abort(): void {
    this.rootAbort?.abort();
    for (const ac of this.fileAborts.values()) ac.abort();
    this.writeMetadata('aborted');
  }

  skipFile(index: number): boolean {
    const ac = this.fileAborts.get(index);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  // --- internals ---

  private emit(ev: ServerEvent): void {
    for (const fn of this.listeners) {
      try { fn(ev); } catch { /* listener errors don't bubble */ }
    }
  }

  private setPhase(phase: ScanPhase): void {
    this.state.phase = phase;
    this.emit({ type: 'phase', phase });
  }

  private updateFile(index: number, patch: Partial<FileEntry>): void {
    const cur = this.state.files[index];
    if (!cur) return;
    const merged: FileEntry = { ...cur, ...patch };
    this.state.files[index] = merged;
    this.emit({ type: 'file-update', index, patch });
  }

  private addTokens(t: number): void {
    this.state.tokens += t;
    this.emit({ type: 'tokens', tokens: this.state.tokens });
  }

  private writeMetadata(status: ScanMetadata['status']): void {
    try {
      mkdirSync(this.outputDir, { recursive: true });
      const meta: ScanMetadata = {
        slug: this.state.repoSlug,
        repoPath: path.resolve(this.state.targetRepo),
        primaryModel: this.state.primaryModel,
        secondaryModel: this.state.secondaryModel,
        provider: this.state.provider,
        effort: this.state.effort,
        parallel: this.state.parallel,
        startedAt: this.startedAt,
        lastUpdatedAt: Date.now(),
        status,
      };
      writeFileSync(path.join(this.outputDir, 'metadata.json'), JSON.stringify(meta, null, 2));
    } catch {
      // Non-fatal; metadata is for the UI listing only.
    }
  }

  private async run(): Promise<void> {
    ensureOutputDir(this.outputDir);
    this.writeMetadata('running');

    // Continuing a previous run: prime the verified counter with whatever
    // exists on disk so the total stays consistent across resumes.
    try {
      this.state.resumedFindings = listVerifiedReports(this.outputDir).length;
    } catch { /* non-fatal */ }

    this.rootAbort = new AbortController();
    this.setPhase('analyst');

    let paths: string[] | null = null;
    for await (const ev of runAnalyst(
      path.resolve(this.state.targetRepo),
      this.outputDir,
      this.state.primaryModel,
      EFFORT_FILE_LIMIT[this.state.effort],
      this.rootAbort.signal,
    )) {
      if (ev.type === 'chunk') {
        const lines = ev.text.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length > 0) {
          this.state.analystThought = lines[lines.length - 1];
          this.emit({ type: 'analyst-chunk', text: this.state.analystThought });
        }
      } else if (ev.type === 'usage') {
        this.addTokens(ev.tokens);
      } else if (ev.type === 'files') {
        paths = ev.files;
      } else if (ev.type === 'error') {
        this.state.fatalError = `Analyst: ${ev.text}`;
        this.setPhase('error');
        this.writeMetadata('error');
        this.emit({ type: 'error', message: this.state.fatalError });
        return;
      } else if (ev.type === 'skipped') {
        this.state.fatalError = 'Analyst skipped — cannot continue without file list.';
        this.setPhase('error');
        this.writeMetadata('aborted');
        this.emit({ type: 'error', message: this.state.fatalError });
        return;
      }
    }

    if (!paths) {
      this.state.fatalError = 'Analyst produced no file list.';
      this.setPhase('error');
      this.writeMetadata('error');
      this.emit({ type: 'error', message: this.state.fatalError });
      return;
    }

    const initial: FileEntry[] = paths.map(p => ({
      path: p,
      status: isCached(p, this.cacheFile) ? 'skipped' : 'pending',
      lastThought: '',
    }));
    this.state.files = initial;
    this.emit({ type: 'files-init', files: initial });
    this.setPhase('scanning');

    let cursor = 0;
    const runOne = async (i: number): Promise<void> => {
      const ac = new AbortController();
      this.fileAborts.set(i, ac);
      let finalStatus: FileStatus = 'done';
      let totalFindings: number | undefined;
      let realFindings: number | undefined;

      try {
        for await (const ev of scanAndVerify(
          initial[i].path,
          path.resolve(this.state.targetRepo),
          this.outputDir,
          this.state.primaryModel,
          this.state.secondaryModel,
          ac.signal,
        )) {
          if (ev.type === 'chunk') {
            const lines = ev.text.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length > 0) {
              this.updateFile(i, { lastThought: lines[lines.length - 1] });
            }
          } else if (ev.type === 'usage') {
            this.addTokens(ev.tokens);
          } else if (ev.type === 'stage') {
            this.updateFile(i, { status: ev.stage === 'scanning' ? 'scanning' : 'verifying' });
          } else if (ev.type === 'findings') {
            totalFindings = ev.count;
            this.updateFile(i, { totalFindings: ev.count });
          } else if (ev.type === 'verified') {
            totalFindings = ev.total;
            realFindings = ev.real;
            this.updateFile(i, { totalFindings: ev.total, realFindings: ev.real });
          } else if (ev.type === 'skipped') {
            finalStatus = 'skipped';
          } else if (ev.type === 'error') {
            finalStatus = 'error';
          }
        }
      } finally {
        this.fileAborts.delete(i);
      }

      this.updateFile(i, {
        status: finalStatus,
        totalFindings,
        realFindings,
      });
      if (finalStatus === 'done') markCached(initial[i].path, this.cacheFile);
    };

    const worker = async (): Promise<void> => {
      while (true) {
        const i = cursor++;
        if (i >= initial.length) return;
        if (initial[i].status === 'skipped') continue;
        await runOne(i);
      }
    };

    const lanes = Math.max(1, Math.min(this.state.parallel, initial.length || 1));
    await Promise.all(Array.from({ length: lanes }, () => worker()));

    const verifiedCount = listVerifiedReports(this.outputDir).length;
    this.setPhase(verifiedCount > 0 ? 'browse' : 'done');
    this.writeMetadata(this.rootAbort?.signal.aborted ? 'aborted' : 'completed');
    this.emit({ type: 'done', verifiedCount });
  }
}

// ---------- Registry ----------

export class ScanRegistry {
  private active: ScanRunner | null = null;

  getActive(): ScanRunner | null {
    if (this.active && !this.active.isRunning && this.active.snapshot.phase !== 'browse' && this.active.snapshot.phase !== 'done' && this.active.snapshot.phase !== 'error') {
      // pathological, but just in case
      this.active = null;
    }
    return this.active;
  }

  getBySlug(slug: string): ScanRunner | null {
    if (this.active && this.active.slug === slug) return this.active;
    return null;
  }

  start(opts: ScanStartOpts): ScanRunner {
    if (this.active && this.active.isRunning) {
      throw new ScanConflictError(this.active.slug);
    }
    const runner = new ScanRunner(opts);
    this.active = runner;
    runner.start();
    return runner;
  }
}

export class ScanConflictError extends Error {
  constructor(public readonly activeSlug: string) {
    super(`A scan is already running (slug: ${activeSlug}).`);
    this.name = 'ScanConflictError';
  }
}

// ---------- Past-scan listing ----------

const SEVERITY_RX = /^(critical|high|medium|low)$/;

export function listPastScans(): PastScanSummary[] {
  const outputRoot = path.join(PACKAGE_ROOT, 'output');
  if (!existsSync(outputRoot)) return [];

  const results: PastScanSummary[] = [];
  for (const entry of readdirSync(outputRoot)) {
    const dir = path.join(outputRoot, entry);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;

    const metaPath = path.join(dir, 'metadata.json');
    let meta: ScanMetadata | null = null;
    if (existsSync(metaPath)) {
      try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) as ScanMetadata; }
      catch { meta = null; }
    }

    // Reconstruct minimal metadata for scans created before metadata.json
    // existed. We can't recover the repo path; use the slug.
    if (!meta) {
      meta = {
        slug: entry,
        repoPath: entry,
        primaryModel: '',
        secondaryModel: '',
        provider: 'openrouter',
        effort: 'low',
        parallel: 1,
        startedAt: st.birthtimeMs || st.mtimeMs,
        lastUpdatedAt: st.mtimeMs,
        status: 'completed',
      };
    }

    let verifiedCount = 0;
    let candidateCount = 0;
    let fileCount = 0;
    const findingsDir = path.join(dir, 'findings');
    if (existsSync(findingsDir)) {
      for (const f of readdirSync(findingsDir)) {
        if (!f.endsWith('.json')) continue;
        fileCount++;
        try {
          const data = JSON.parse(readFileSync(path.join(findingsDir, f), 'utf8')) as {
            findings?: Array<{ severity?: string; verified?: boolean }>;
          };
          for (const finding of data.findings ?? []) {
            if (typeof finding?.severity === 'string' && SEVERITY_RX.test(finding.severity)) {
              candidateCount++;
              if (finding.verified === true) verifiedCount++;
            }
          }
        } catch { /* skip bad json */ }
      }
    }

    results.push({ ...meta, fileCount, verifiedCount, candidateCount, isActive: false });
  }

  results.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
  return results;
}
