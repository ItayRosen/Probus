// Mirrors src/server/events.ts and the route response shapes.

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

export type KnownProvider = 'openrouter' | 'openai' | 'anthropic';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type ScanStatus = 'running' | 'completed' | 'aborted' | 'error';

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

export interface ProviderInfo {
  id: KnownProvider;
  label: string;
  envVar: string;
  hasKey: boolean;
  defaults: { primary: string; secondary: string };
}

export interface ConfigPayload {
  detected: KnownProvider | null;
  envFile: string;
  home: string;
  cwd: string;
  providers: ProviderInfo[];
}

export interface FsEntry {
  name: string;
  isDir: boolean;
  hidden: boolean;
}

export interface FsListResponse {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  truncated: boolean;
  slug: string;
  hasExistingScan: boolean;
}

export interface FsRootsResponse {
  home: string;
  cwd: string;
  roots: Array<{ label: string; path: string }>;
}

// ---- chat ----

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

export type ChatStatus = 'idle' | 'streaming' | 'error';

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

export interface GhStatus {
  installed: boolean;
  authed: boolean;
  version?: string;
  user?: string;
  detail?: string;
}

export interface ReportSummary {
  file: string;
  name: string;
  severity: Severity;
  description: string;
  reason?: string;
  reportId: string;
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
  status: ScanStatus;
}

export interface PastScanSummary extends ScanMetadata {
  fileCount: number;
  verifiedCount: number;
  candidateCount: number;
  isActive: boolean;
}

export interface ValidateRepoResponse {
  absolutePath: string;
  slug: string;
  outputDir: string;
  hasExistingScan: boolean;
}

export interface ScanDetailResponse {
  slug: string;
  outputDir: string;
  metadata: ScanMetadata | null;
  state: ScanState | null;
  isActive: boolean;
  isRunning: boolean;
  reports: ReportSummary[];
}
