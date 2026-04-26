import type { Effort } from './ui/App.js';
import { detectProvider, defaultModels, type KnownProvider } from './providers.js';

export type ParsedArgs =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'view'; repo: string }
  | {
      kind: 'scan';
      repo: string;
      primaryModel: string | null; // null = pick default after key is available
      secondaryModel: string | null;
      effort: Effort;
      preferredProvider: KnownProvider | null; // from --provider or null = detect
      parallel: number; // how many files to scan concurrently (default 1)
    };

export const DEFAULT_EFFORT: Effort = 'low';
export const DEFAULT_PARALLEL = 1;
const MAX_PARALLEL = 16;

const EFFORTS: ReadonlySet<Effort> = new Set<Effort>(['low', 'medium', 'high']);
const PROVIDERS: ReadonlySet<string> = new Set(['openai', 'openrouter', 'anthropic']);

export function parseArgs(rawArgs: string[]): ParsedArgs {
  if (rawArgs.length === 0 || rawArgs[0] === '--help' || rawArgs[0] === '-h') {
    return { kind: 'help' };
  }

  let effort: Effort = DEFAULT_EFFORT;
  let primaryModel: string | null = null;
  let secondaryModel: string | null = null;
  let preferredProvider: KnownProvider | null = null;
  let parallel: number = DEFAULT_PARALLEL;
  const positional: string[] = [];

  const takeValue = (flag: string, i: number): [string, number] | string => {
    const eqIdx = rawArgs[i].indexOf('=');
    if (eqIdx !== -1) return [rawArgs[i].slice(eqIdx + 1), i];
    const v = rawArgs[i + 1];
    if (v === undefined) return `Missing value for ${flag}`;
    return [v, i + 1];
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (!a) continue;

    if (a === '--effort' || a.startsWith('--effort=')) {
      const r = takeValue('--effort', i);
      if (typeof r === 'string') return { kind: 'error', message: r };
      const [v, next] = r;
      if (!EFFORTS.has(v as Effort)) {
        return { kind: 'error', message: `Invalid --effort value: ${v}. Must be low, medium, or high.` };
      }
      effort = v as Effort;
      i = next;
    } else if (a === '--primaryModel' || a === '--primary-model' || a.startsWith('--primaryModel=') || a.startsWith('--primary-model=')) {
      const r = takeValue('--primaryModel', i);
      if (typeof r === 'string') return { kind: 'error', message: r };
      primaryModel = r[0]; i = r[1];
    } else if (a === '--secondaryModel' || a === '--secondary-model' || a.startsWith('--secondaryModel=') || a.startsWith('--secondary-model=')) {
      const r = takeValue('--secondaryModel', i);
      if (typeof r === 'string') return { kind: 'error', message: r };
      secondaryModel = r[0]; i = r[1];
    } else if (a === '--provider' || a.startsWith('--provider=')) {
      const r = takeValue('--provider', i);
      if (typeof r === 'string') return { kind: 'error', message: r };
      const [v, next] = r;
      if (!PROVIDERS.has(v)) {
        return { kind: 'error', message: `Invalid --provider value: ${v}. Must be openai, openrouter, or anthropic.` };
      }
      preferredProvider = v as KnownProvider;
      i = next;
    } else if (a === '--parallel' || a.startsWith('--parallel=')) {
      const r = takeValue('--parallel', i);
      if (typeof r === 'string') return { kind: 'error', message: r };
      const [v, next] = r;
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1 || n > MAX_PARALLEL) {
        return { kind: 'error', message: `Invalid --parallel value: ${v}. Must be an integer between 1 and ${MAX_PARALLEL}.` };
      }
      parallel = n;
      i = next;
    } else if (a.startsWith('--')) {
      return { kind: 'error', message: `Unknown flag: ${a}` };
    } else {
      positional.push(a);
    }
  }

  const [cmd, repo] = positional;

  if (cmd === 'view') {
    if (!repo) return { kind: 'error', message: 'Usage: probus view <repo-path>' };
    return { kind: 'view', repo };
  }

  if (cmd === 'scan') {
    if (!repo) {
      return { kind: 'error', message: 'Usage: probus scan <repo-path> [--effort ...] [--primaryModel ...] [--secondaryModel ...]' };
    }
    return { kind: 'scan', repo, primaryModel, secondaryModel, effort, preferredProvider, parallel };
  }

  return { kind: 'error', message: `Unknown command: ${cmd ?? '(missing)'}` };
}

/** Resolve model defaults given the provider (detected or explicit). */
export function resolveDefaults(
  preferred: KnownProvider | null,
  env: NodeJS.ProcessEnv = process.env,
): { provider: KnownProvider | null; primary: string; secondary: string } | null {
  const provider = preferred ?? detectProvider(env);
  if (!provider) return null;
  const d = defaultModels(provider);
  return { provider, primary: d.primary, secondary: d.secondary };
}

// ANSI styling — only emitted if stdout is a TTY and NO_COLOR isn't set.
const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const wrap = (open: string, close: string) =>
  (s: string) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);
const bold = wrap('1', '22');
const dim = wrap('2', '22');
const cyan = wrap('36', '39');
const magenta = wrap('35', '39');
const yellow = wrap('33', '39');
const green = wrap('32', '39');

const heading = (s: string) => bold(magenta(s));
const flag = (s: string) => cyan(s);
const cmd = (s: string) => green(s);
const arg = (s: string) => yellow(s);

export const HELP_TEXT = [
  '',
  `  ${bold(magenta('probus'))} ${dim('— agentic security scanner for code repos')}`,
  '',
  `  ${heading('USAGE')}`,
  `    ${cmd('probus scan')} ${arg('<repo-path>')} ${dim('[options]')}`,
  `    ${cmd('probus view')} ${arg('<repo-path>')}`,
  '',
  `  ${heading('COMMANDS')}`,
  `    ${cmd('scan')}    Run analyst → primary → secondary on a repo`,
  `    ${cmd('view')}    Browse a previously-scanned repo's reports`,
  '',
  `  ${heading('OPTIONS')}`,
  `    ${flag('--effort')} ${arg('<low|medium|high>')}    File budget for the analyst.`,
  `                                ${dim('low ≈ 50 · medium ≈ 100 · high ≈ 500   (default: low)')}`,
  `    ${flag('--parallel')} ${arg('<N>')}                Files to scan concurrently. ${dim('(default: 1, max: 16)')}`,
  `    ${flag('--provider')} ${arg('<openrouter|openai|anthropic>')}`,
  `                                Force a provider when multiple ${arg('*_API_KEY')} env vars are set.`,
  `    ${flag('--primaryModel')} ${arg('<slug>')}         Override the primary model (per-file scanner).`,
  `    ${flag('--secondaryModel')} ${arg('<slug>')}       Override the secondary model (verifier).`,
  `    ${flag('-h')}, ${flag('--help')}                      Show this help.`,
  '',
  `  ${heading('MODELS')}`,
  `    Model slugs look like ${arg('<provider>/<model>')}, e.g. ${arg('openai/gpt-5.4')}`,
  `    or ${arg('openrouter/qwen/qwen3.6-plus')}.`,
  '',
  `    Defaults are picked from whichever ${arg('*_API_KEY')} is set:`,
  `      ${dim('OPENROUTER_API_KEY  →  openrouter (preferred)')}`,
  `      ${dim('OPENAI_API_KEY      →  openai')}`,
  `      ${dim('ANTHROPIC_API_KEY   →  anthropic')}`,
  '',
  `  ${heading('EXAMPLES')}`,
  `    ${dim('# scan a repo with defaults')}`,
  `    ${cmd('$')} probus scan ./my-app`,
  '',
  `    ${dim('# medium effort, 4 files in parallel')}`,
  `    ${cmd('$')} probus scan ./my-app --effort medium --parallel 4`,
  '',
  `    ${dim('# pin specific models')}`,
  `    ${cmd('$')} probus scan ./my-app \\`,
  `        --primaryModel anthropic/claude-sonnet-4-6 \\`,
  `        --secondaryModel anthropic/claude-opus-4-7`,
  '',
  `    ${dim('# browse previous results')}`,
  `    ${cmd('$')} probus view ./my-app`,
  '',
  `  ${dim('Docs: https://github.com/ItayRosen/Probus')}`,
  '',
].join('\n');
