# Contributing to probus

Thanks for your interest! This doc gets you from `git clone` to a passing PR.

## Dev setup

```bash
git clone https://github.com/<your-fork>/probus.git
cd probus
nvm use         # uses .nvmrc (Node 20)
npm install
```

## Run it locally

```bash
npm run build:web   # build the React UI once
npm run dev         # boots Express + opens browser to localhost:PORT
```

The web UI handles everything: provider/key setup, picking a repo, starting and watching scans, and browsing past reports.

## Scripts

| Command             | What it does                                                              |
| ------------------- | ------------------------------------------------------------------------- |
| `npm run build`     | Build the web app (Vite) and the server (TypeScript) — required once     |
| `npm run build:web` | Build only the React web UI (`web/` → `dist/web/`)                       |
| `npm run build:server` | Build only the server (`src/` → `dist/`)                              |
| `npm run dev`       | Run the CLI with `tsx` (requires `build:web` to have been run once)      |
| `npm run dev:web`   | Vite dev server on :5173 with HMR (proxies `/api` to backend on :9091)   |
| `npm test`          | Run the `vitest` suite                                                    |
| `npm run typecheck` | `tsc --noEmit` — CI runs this                                            |

## Before opening a PR

1. `npm run typecheck` — no errors.
2. `npm test` — all green.
3. Keep PRs focused. One concern per PR.
4. Add/update tests when you change `src/scanner.ts` pure helpers, `src/env.ts`, or `src/cli.ts`.

## Architecture sketch

```
Launcher (src/cli.ts + src/index.ts)   — binds 127.0.0.1, opens browser
   │
   ▼
Express server (src/server/*)
   ├─ /api/config, /api/keys          (provider list, save keys)
   ├─ /api/validate-repo              (resolve user-typed paths)
   ├─ /api/scans                       (GET = list past, POST = start)
   ├─ /api/active                      ({ slug } of running scan, if any)
   ├─ /api/scans/:slug                 (metadata + reports, live or past)
   ├─ /api/scans/:slug/events          (SSE — live per-file events)
   ├─ /api/scans/:slug/{abort,skip}
   └─ /api/scans/:slug/reports[/:id]
   │
   ▼
React SPA (web/src/*) — Home → NewScan → ScanView (dashboard or reports)
   │
   ▼
Pipeline (src/scanner.ts) — runAnalyst + scanAndVerify async generators
   ├─ Analyst   : picks files to inspect
   ├─ Researcher: raw findings per file
   └─ QA        : verifies + writes markdown reports
   │
   ▼
Claude Agent SDK → OpenRouter / OpenAI / Anthropic
```

Output lives in `output/<repo-slug>/` — findings JSON, markdown reports, per-file debug logs.

## Reporting security issues

Please see [SECURITY.md](./SECURITY.md). Don't open public issues for suspected vulnerabilities in probus itself.

## Code of Conduct

Participation is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
