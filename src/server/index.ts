// Boots the Express server, serves the React SPA, picks a free localhost
// port (or PROBUS_PORT), and opens the user's browser.
//
// In dev mode (PROBUS_DEV=1) we mount Vite as middleware so `web/` has HMR
// and `npm run dev` is the only command you need. In prod we serve the
// prebuilt `dist/web/`.

import express, { type Request, type Response, type NextFunction } from 'express';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createApiRouter } from './routes.js';
import { PACKAGE_ROOT, WEB_DIR } from '../paths.js';

const HOST = '127.0.0.1';

export interface StartServerOpts {
  port?: number; // 0 = pick free
  openBrowser?: boolean;
}

export async function startServer(opts: StartServerOpts = {}): Promise<{
  url: string;
  port: number;
  dev: boolean;
  close: () => Promise<void>;
}> {
  const app = express();
  app.disable('etag');

  const api = createApiRouter();
  app.use('/api', api);

  const devMode = process.env.PROBUS_DEV === '1';

  // Create the HTTP server up front so Vite can share its WebSocket with us
  // (avoids a second HMR port that the browser may fail to reach).
  const server = http.createServer(app);

  if (devMode) {
    // Dev mode: Vite middleware gives us HMR on web/ without a build step.
    // Vite is a devDep — only imported when explicitly requested.
    const { createServer: createVite } = await import('vite');
    const webRoot = path.join(PACKAGE_ROOT, 'web');
    const vite = await createVite({
      server: {
        middlewareMode: true,
        // Reuse our Node HTTP server for the HMR WebSocket. Without this,
        // Vite opens a second port that the browser may not reach (firewall,
        // mismatched origin, etc.) so HMR silently fails.
        hmr: { server },
        watch: { usePolling: false },
      },
      appType: 'custom',
      root: webRoot,
      configFile: path.join(webRoot, 'vite.config.ts'),
    });
    app.use(vite.middlewares);
    // SPA fallback that runs *after* Vite — Vite handles its own assets;
    // anything else (including / and deep links like /scans/foo) gets the
    // transformed index.html with HMR injected.
    app.use(async (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api/')) return next();
      try {
        const html = readFileSync(path.join(webRoot, 'index.html'), 'utf8');
        const transformed = await vite.transformIndexHtml(req.originalUrl, html);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(transformed);
      } catch (err) {
        vite.ssrFixStacktrace?.(err as Error);
        next(err);
      }
    });
  } else {
    // Prod mode: serve the built SPA.
    const hasBuild = existsSync(path.join(WEB_DIR, 'index.html'));
    if (hasBuild) {
      app.use(express.static(WEB_DIR, { index: 'index.html', maxAge: 0 }));
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
  }

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
    dev: devMode,
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
