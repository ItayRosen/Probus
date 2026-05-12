// Boots the Express server, serves the built React SPA from dist/web,
// picks a free localhost port (or PROBUS_PORT), and opens the user's browser.

import express, { type Request, type Response } from 'express';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createApiRouter } from './routes.js';
import { WEB_DIR } from '../paths.js';

const HOST = '127.0.0.1';

export interface StartServerOpts {
  port?: number; // 0 = pick free
  openBrowser?: boolean;
}

export async function startServer(opts: StartServerOpts = {}): Promise<{
  url: string;
  port: number;
  close: () => Promise<void>;
}> {
  const app = express();
  app.disable('etag');

  const api = createApiRouter();
  app.use('/api', api);

  // Serve the built SPA. If it isn't there, surface a friendly error.
  const hasBuild = existsSync(path.join(WEB_DIR, 'index.html'));
  if (hasBuild) {
    app.use(express.static(WEB_DIR, { index: 'index.html', maxAge: 0 }));
    // SPA fallback: anything that isn't a file and isn't /api → index.html.
    app.get(/^\/(?!api\/).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(WEB_DIR, 'index.html'));
    });
  } else {
    app.get('/', (_req: Request, res: Response) => {
      res.status(503).type('text/plain').send(
        `Probus web build not found at ${WEB_DIR}.\n\n` +
        `Run \`npm run build:web\` (or \`npm run build\`) and try again.\n`,
      );
    });
  }

  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, HOST, () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://${HOST}:${port}`;

  if (opts.openBrowser) openInBrowser(url);

  return {
    url,
    port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Couldn't open — the user can copy the URL from the console.
  }
}
