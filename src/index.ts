#!/usr/bin/env node

// Entry point. Boots the Express + React UI on localhost and opens the
// browser. Everything else — repo selection, scan config, provider keys,
// live progress, report browsing — happens in the web app.

import { loadDotenv } from './env.js';
import { parseArgs, HELP_TEXT } from './cli.js';
import { shutdownBifrost } from './bifrost.js';
import { startServer } from './server/index.js';
import { WEB_DIR } from './paths.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

loadDotenv();

const parsed = parseArgs(process.argv.slice(2));

const shutdown = () => {
  shutdownBifrost().catch(() => { /* ignore */ }).finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { void shutdownBifrost(); });

async function main(): Promise<void> {
  switch (parsed.kind) {
    case 'help':
      console.log(HELP_TEXT);
      process.exit(0);
    case 'error':
      console.error(parsed.message);
      process.exit(1);
    case 'run': {
      const devMode = process.env.PROBUS_DEV === '1';
      if (!devMode && !existsSync(path.join(WEB_DIR, 'index.html'))) {
        console.error(
          `\n  Probus web bundle not found at ${WEB_DIR}.\n` +
          `  Run \`npm run build\` (or \`npm run build:web\`) and try again.\n`,
        );
        process.exit(1);
      }

      const portEnv = process.env.PROBUS_PORT ? Number(process.env.PROBUS_PORT) : undefined;
      const noOpenEnv = !!process.env.PROBUS_NO_OPEN;

      try {
        const { url, dev } = await startServer({
          port: parsed.port ?? portEnv,
          openBrowser: parsed.openBrowser && !noOpenEnv,
        });
        printBanner(url, dev);
      } catch (err) {
        if (err && typeof err === 'object' && (err as { code?: string }).code === 'EADDRINUSE') {
          const port = parsed.port ?? portEnv ?? '?';
          console.error(
            `\n  Port ${port} is already in use.\n` +
            `  Another \`probus\` process is probably still running.\n\n` +
            `  Free it up:\n` +
            `    lsof -ti :${port} | xargs kill\n` +
            `  Or pick a different port:\n` +
            `    PROBUS_PORT=9092 npm run dev\n`,
          );
          process.exit(1);
        }
        throw err;
      }
      // Keep alive until SIGINT/SIGTERM.
      await new Promise<void>(() => { /* never resolves */ });
    }
  }
}

function printBanner(url: string, dev: boolean): void {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const c = (open: string, close: string) => (s: string) => useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;
  const bold = c('1', '22');
  const dim = c('2', '22');
  const cyan = c('36', '39');
  const magenta = c('35', '39');

  const modeLine = dev
    ? `  ${dim('Mode')}  ${bold(cyan('dev'))} ${dim('(Vite HMR for web/, tsx-watch for src/ — no build step)')}`
    : `  ${dim('Mode')}  ${bold('prod')} ${dim('(serving prebuilt dist/web/)')}`;

  const banner = [
    '',
    `  ${bold(magenta('probus'))} ${dim('— agentic security scanner')}`,
    '',
    modeLine,
    `  ${dim('Open')}  ${bold(cyan(url))}`,
    `  ${dim('Stop')}  ${bold('Ctrl+C')}`,
    '',
  ].join('\n');
  console.log(banner);
}

main().catch(err => {
  console.error('Fatal:', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
