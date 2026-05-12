import { useEffect, useMemo, useState } from 'react';
import { api } from './api.ts';
import type { ConfigPayload } from './types.ts';
import { matchRoute, useRoute } from './router.ts';
import { TopBar } from './components/TopBar.tsx';
import { Home } from './components/Home.tsx';
import { NewScan } from './components/NewScan.tsx';
import { Settings } from './components/Settings.tsx';
import { ScanView } from './components/ScanView.tsx';

export function App() {
  const route = useRoute();
  const current = useMemo(() => matchRoute(route.path), [route.path]);
  const [config, setConfig] = useState<ConfigPayload | null>(null);
  const [configBumper, setConfigBumper] = useState(0);

  useEffect(() => {
    let mounted = true;
    api.config()
      .then(c => { if (mounted) setConfig(c); })
      .catch(() => { /* surface in pages that need it */ });
    return () => { mounted = false; };
  }, [configBumper]);

  const refreshConfig = () => setConfigBumper(n => n + 1);

  return (
    <div className="app">
      <TopBar route={current} navigate={route.navigate} />
      <div className="shell">
        {current.name === 'home' && (
          <Home navigate={route.navigate} />
        )}
        {current.name === 'new' && (
          <NewScan
            config={config}
            navigate={route.navigate}
            onKeySaved={refreshConfig}
          />
        )}
        {current.name === 'settings' && (
          <Settings config={config} onSaved={refreshConfig} />
        )}
        {current.name === 'scan' && (
          <ScanView slug={current.slug} navigate={route.navigate} />
        )}
        {current.name === 'not-found' && (
          <div className="empty-state fade-in">
            <h3>Page not found</h3>
            <p>That route doesn't exist.</p>
            <button className="btn primary" onClick={() => route.navigate('/')}>Go home</button>
          </div>
        )}
      </div>
    </div>
  );
}
