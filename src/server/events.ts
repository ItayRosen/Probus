// Canonical SSE event shapes. Mirrored by web/src/types.ts on the client side.
//
// The server keeps the authoritative scan state in memory and emits one of
// these events on every update. New SSE subscribers get a `snapshot` first,
// then a live tail.

import type { KnownProvider } from '../providers.js';

export type FileStatus =
  | 'pending'
  | 'scanning'
  | 'verifying'
  | 'done'
  | 'skipped'
  | 'error';

export interface FileEntry {
  path: string;
  status: FileStatus;
  lastThought: string;
  totalFindings?: number;
  realFindings?: number;
}

export type ScanPhase =
  | 'idle'
  | 'analyst'
  | 'scanning'
  | 'browse'
  | 'done'
  | 'error';

export interface ScanState {
  phase: ScanPhase;
  targetRepo: string;
  repoSlug: string;
  primaryModel: string;
  secondaryModel: string;
  provider: KnownProvider;
  effort: 'low' | 'medium' | 'high';
  parallel: number;
  files: FileEntry[];
  analystThought: string;
  tokens: number;
  resumedFindings: number;
  fatalError: string | null;
  startedAt: number;
}

export type ServerEvent =
  | { type: 'snapshot'; state: ScanState }
  | { type: 'phase'; phase: ScanPhase }
  | { type: 'analyst-chunk'; text: string }
  | { type: 'files-init'; files: FileEntry[] }
  | { type: 'file-update'; index: number; patch: Partial<FileEntry> }
  | { type: 'tokens'; tokens: number }
  | { type: 'error'; message: string }
  | { type: 'done'; verifiedCount: number };
