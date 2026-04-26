#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './ui/App.js';
import { loadDotenv } from './env.js';
import { parseArgs, HELP_TEXT } from './cli.js';
import { shutdownBifrost } from './bifrost.js';

loadDotenv();

const parsed = parseArgs(process.argv.slice(2));

const shutdown = () => {
  shutdownBifrost().catch(() => { /* ignore */ }).finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { void shutdownBifrost(); });

switch (parsed.kind) {
  case 'help':
    console.log(HELP_TEXT);
    process.exit(0);
  case 'error':
    console.error(parsed.message);
    process.exit(1);
  case 'view':
    render(<App targetRepo={parsed.repo} primaryModel={null} secondaryModel={null} mode="view" />);
    break;
  case 'scan':
    render(
      <App
        targetRepo={parsed.repo}
        primaryModel={parsed.primaryModel}
        secondaryModel={parsed.secondaryModel}
        effort={parsed.effort}
        preferredProvider={parsed.preferredProvider}
        parallel={parsed.parallel}
      />,
    );
    break;
}
