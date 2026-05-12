import { useState } from 'react';
import { api } from '../api.ts';
import type { ConfigPayload, KnownProvider } from '../types.ts';

interface Props {
  config: ConfigPayload | null;
  onSaved: () => void;
}

export function Settings({ config, onSaved }: Props) {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<KnownProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Record<string, number>>({});

  if (!config) {
    return <div className="empty-state">Loading…</div>;
  }

  const save = async (p: KnownProvider) => {
    const value = (keys[p] ?? '').trim();
    if (!value) return;
    setError(null);
    setSaving(p);
    try {
      await api.saveKey(p, value);
      setKeys(prev => ({ ...prev, [p]: '' }));
      setSavedAt(prev => ({ ...prev, [p]: Date.now() }));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="form-wrap fade-in">
      <div className="home-head">
        <div>
          <h1 className="home-title">Settings</h1>
          <div className="home-sub">Manage API keys for your model providers.</div>
        </div>
      </div>

      <div className="panel">
        {config.providers.map(p => (
          <div className="form-section" key={p.id}>
            <div>
              <div className="form-section-head">{p.label}</div>
              <div className="form-section-sub">
                <div className="mono" style={{ fontSize: 11 }}>{p.envVar}</div>
                <div style={{ marginTop: 6 }}>
                  default {p.defaults.primary.split('/').slice(-1)[0]} → {p.defaults.secondary.split('/').slice(-1)[0]}
                </div>
              </div>
            </div>
            <div>
              <div className="row" style={{ gap: 10, marginBottom: 10 }}>
                {p.hasKey
                  ? <span className="chip dot" style={{ color: 'var(--ok)' }}>Key on file</span>
                  : <span className="chip" style={{ color: 'var(--text-3)' }}>No key yet</span>}
                {savedAt[p.id] && Date.now() - savedAt[p.id] < 5000 && (
                  <span className="muted" style={{ fontSize: 11 }}>saved ✓</span>
                )}
              </div>
              <div className="row" style={{ gap: 8 }}>
                <input
                  type="password"
                  className="input"
                  placeholder={p.hasKey ? '••••••• (replace)' : 'sk-...'}
                  value={keys[p.id] ?? ''}
                  onChange={e => setKeys(prev => ({ ...prev, [p.id]: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') save(p.id); }}
                />
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => save(p.id)}
                  disabled={!keys[p.id]?.trim() || saving === p.id}
                >
                  {saving === p.id ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="help-text" style={{ marginTop: 16 }}>
        Keys are stored locally in <span style={{ color: 'var(--text-2)' }}>{config.envFile}</span> (chmod 600).
      </div>

      {error && (
        <div className="error-banner" style={{ marginTop: 16 }}>
          <div><div className="err-title">Could not save key</div><div className="muted">{error}</div></div>
        </div>
      )}
    </div>
  );
}
