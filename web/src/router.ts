// A tiny path-based router. No external deps, no hash routing.
//
//   useRoute()           current path + a navigate function
//   matchRoute(path)     parses /scans/:slug → { name, slug? }
//
// The Express server has SPA fallback, so refreshing on /scans/xyz works.

import { useEffect, useState, useCallback } from 'react';

export interface RouteInfo {
  path: string;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
}

export function useRoute(): RouteInfo {
  const [path, setPath] = useState<string>(() =>
    typeof window === 'undefined' ? '/' : window.location.pathname || '/',
  );

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname || '/');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    if (typeof window === 'undefined') return;
    if (opts?.replace) window.history.replaceState(null, '', to);
    else window.history.pushState(null, '', to);
    setPath(to);
  }, []);

  return { path, navigate };
}

export type Route =
  | { name: 'home' }
  | { name: 'new' }
  | { name: 'scan'; slug: string }
  | { name: 'fix'; slug: string; reportId: string }
  | { name: 'settings' }
  | { name: 'not-found'; path: string };

export function matchRoute(rawPath: string): Route {
  const path = rawPath.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
  if (path === '/' || path === '') return { name: 'home' };
  if (path === '/new') return { name: 'new' };
  if (path === '/settings') return { name: 'settings' };
  const fix = path.match(/^\/scans\/([^/]+)\/fix\/([^/]+)$/);
  if (fix) return { name: 'fix', slug: decodeURIComponent(fix[1]), reportId: decodeURIComponent(fix[2]) };
  const m = path.match(/^\/scans\/([^/]+)$/);
  if (m) return { name: 'scan', slug: decodeURIComponent(m[1]) };
  return { name: 'not-found', path };
}
