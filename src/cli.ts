// `probus` is now a launcher — no subcommands. The web UI drives everything.
//
//   probus              start server, open browser
//   probus --port 8080  pin a port (default: 0 → pick free)
//   probus --no-open    don't auto-open the browser
//   probus -h           print help

export type ParsedArgs =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'run'; port: number | null; openBrowser: boolean };

export function parseArgs(rawArgs: string[]): ParsedArgs {
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    return { kind: 'help' };
  }

  let port: number | null = null;
  let openBrowser = true;

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
    if (a === '--port' || a.startsWith('--port=')) {
      const r = takeValue('--port', i);
      if (typeof r === 'string') return { kind: 'error', message: r };
      const [v, next] = r;
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0 || n > 65535) {
        return { kind: 'error', message: `Invalid --port value: ${v}.` };
      }
      port = n;
      i = next;
    } else if (a === '--no-open') {
      openBrowser = false;
    } else if (a === '--open') {
      openBrowser = true;
    } else {
      return { kind: 'error', message: `Unknown argument: ${a}. Run \`probus --help\` for usage.` };
    }
  }

  return { kind: 'run', port, openBrowser };
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

const heading = (s: string) => bold(magenta(s));
const flag = (s: string) => cyan(s);
const arg = (s: string) => yellow(s);

export const HELP_TEXT = [
  '',
  `  ${bold(magenta('probus'))} ${dim('— agentic security scanner for code repos')}`,
  '',
  `  ${heading('USAGE')}`,
  `    ${bold('probus')} ${dim('[options]')}`,
  '',
  `  Launches a local web server and opens the Probus UI in your browser.`,
  `  All scan management — repo selection, provider keys, live progress, and`,
  `  report browsing — happens in the web UI.`,
  '',
  `  ${heading('OPTIONS')}`,
  `    ${flag('--port')} ${arg('<N>')}    Pin the server port. Default: pick a free one.`,
  `    ${flag('--no-open')}    Don't auto-open the browser; just print the URL.`,
  `    ${flag('-h')}, ${flag('--help')}   Show this help.`,
  '',
  `  ${dim('Docs: https://github.com/etairl/Probus')}`,
  '',
].join('\n');
