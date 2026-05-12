import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import type { ConfigPayload, KnownProvider, ValidateRepoResponse } from '../types.ts';

interface Props {
  config: ConfigPayload | null;
  navigate: (to: string) => void;
  onKeySaved: () => void;
}

type Effort = 'low' | 'medium' | 'high';

const EFFORT_LABEL: Record<Effort, { label: string; files: string }> = {
  low: { label: 'Low', files: '~50 files' },
  medium: { label: 'Medium', files: '~100 files' },
  high: { label: 'High', files: '~500 files' },
};

export function NewScan({ config, navigate, onKeySaved }: Props) {
  const [repoPath, setRepoPath] = useState<string>('');
  const [validation, setValidation] = useState<{ ok: ValidateRepoResponse } | { err: string } | null>(null);
  const validateRef = useRef<number | null>(null);

  const [provider, setProvider] = useState<KnownProvider | null>(null);
  const [apiKey, setApiKey] = useState<string>('');
  const [primaryModel, setPrimaryModel] = useState<string>('');
  const [secondaryModel, setSecondaryModel] = useState<string>('');
  const [effort, setEffort] = useState<Effort>('low');
  const [parallel, setParallel] = useState<number>(1);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Seed provider from server-detected one when config loads.
  useEffect(() => {
    if (!config || provider) return;
    setProvider(config.detected ?? 'openrouter');
  }, [config]);

  const providerInfo = useMemo(
    () => config?.providers.find(p => p.id === provider),
    [config, provider],
  );

  // Reset model placeholders when provider switches.
  useEffect(() => {
    if (!providerInfo) return;
    setPrimaryModel('');
    setSecondaryModel('');
  }, [providerInfo?.id]);

  // Debounced repo validation.
  useEffect(() => {
    if (!repoPath.trim()) { setValidation(null); return; }
    if (validateRef.current) window.clearTimeout(validateRef.current);
    validateRef.current = window.setTimeout(async () => {
      try {
        const r = await api.validateRepo(repoPath);
        setValidation({ ok: r });
      } catch (err) {
        setValidation({ err: err instanceof Error ? err.message : String(err) });
      }
    }, 250);
    return () => { if (validateRef.current) window.clearTimeout(validateRef.current); };
  }, [repoPath]);

  const validRepo = validation && 'ok' in validation ? validation.ok : null;
  const hasKey = !!providerInfo?.hasKey;
  const needKeyEntry = !hasKey;
  const keyValid = !needKeyEntry || apiKey.trim().length > 0;
  const canSubmit = !!provider && !!validRepo && keyValid && !submitting;

  const submit = async () => {
    if (!provider || !validRepo) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      if (needKeyEntry) {
        await api.saveKey(provider, apiKey.trim());
        onKeySaved();
      }
      const r = await api.startScan({
        repoPath: validRepo.absolutePath,
        provider,
        primaryModel: primaryModel.trim() || undefined,
        secondaryModel: secondaryModel.trim() || undefined,
        effort,
        parallel,
      });
      navigate(`/scans/${encodeURIComponent(r.slug)}`);
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string; data?: { activeSlug?: string } };
      if (e?.status === 409 && e.data?.activeSlug) {
        setSubmitError(`A scan is already running. Click "Scans" to view it.`);
      } else {
        setSubmitError(e?.message ?? String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="form-wrap fade-in">
      <div className="home-head">
        <div>
          <h1 className="home-title">New scan</h1>
          <div className="home-sub">Point Probus at a local repo and pick a model provider.</div>
        </div>
      </div>

      <div className="panel">
        {/* --- repo --- */}
        <div className="form-section">
          <div>
            <div className="form-section-head">Repository</div>
            <div className="form-section-sub">An absolute or relative path on this machine.</div>
          </div>
          <div>
            <label className="label">Repo path</label>
            <input
              className="input"
              placeholder="/Users/you/code/my-app  or  ~/code/my-app"
              value={repoPath}
              onChange={e => setRepoPath(e.target.value)}
              autoFocus
              spellCheck={false}
            />
            {validation && 'ok' in validation && (
              <div className="path-hint ok">
                ✓ {validation.ok.absolutePath}
                {validation.ok.hasExistingScan && (
                  <span style={{ marginLeft: 10, color: 'var(--text-2)' }}>
                    · existing scan will be resumed
                  </span>
                )}
              </div>
            )}
            {validation && 'err' in validation && (
              <div className="path-hint err">✗ {validation.err}</div>
            )}
          </div>
        </div>

        {/* --- provider --- */}
        <div className="form-section">
          <div>
            <div className="form-section-head">Model provider</div>
            <div className="form-section-sub">
              We use one provider for both the per-file analyst and the verifier.
              {config?.envFile && (
                <div className="mono" style={{ marginTop: 6, fontSize: 11 }}>
                  Keys saved to <span style={{ color: 'var(--text-2)' }}>{config.envFile}</span>
                </div>
              )}
            </div>
          </div>
          <div className="col">
            {config?.providers.map(p => {
              const sel = provider === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`provider-card${sel ? ' selected' : ''}`}
                  onClick={() => setProvider(p.id)}
                >
                  <span className="pdot" />
                  <div style={{ flex: 1 }}>
                    <div className="pname">{p.label}</div>
                    <div className="pmeta">
                      {p.envVar} · {p.defaults.primary.split('/').slice(-1)[0]} → {p.defaults.secondary.split('/').slice(-1)[0]}
                    </div>
                  </div>
                  {p.hasKey && <span className="ptag">key set</span>}
                  {!p.hasKey && p.id === 'openrouter' && (
                    <span className="ptag" style={{ color: 'var(--accent)', background: 'rgba(34,211,238,0.10)', borderColor: 'rgba(34,211,238,0.3)' }}>recommended</span>
                  )}
                </button>
              );
            })}

            {provider && !hasKey && (
              <div style={{ marginTop: 4 }}>
                <label className="label">{providerInfo?.label} API key</label>
                <input
                  className="input"
                  type="password"
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                />
                <div className="help-text">
                  Stored locally at <span style={{ color: 'var(--text-2)' }}>{config?.envFile}</span> (chmod 600). Never sent off-machine.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* --- effort --- */}
        <div className="form-section">
          <div>
            <div className="form-section-head">Effort</div>
            <div className="form-section-sub">How many files the analyst targets for deep review.</div>
          </div>
          <div>
            <div className="row-3">
              {(['low', 'medium', 'high'] as Effort[]).map(e => (
                <button
                  key={e}
                  type="button"
                  className={`seg-btn${effort === e ? ' on' : ''}`}
                  onClick={() => setEffort(e)}
                >
                  {EFFORT_LABEL[e].label}
                  <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-3)', marginTop: 3 }}>
                    {EFFORT_LABEL[e].files}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* --- parallel --- */}
        <div className="form-section">
          <div>
            <div className="form-section-head">Parallelism</div>
            <div className="form-section-sub">Files to scan concurrently (1–16). Higher = faster + more token spend.</div>
          </div>
          <div>
            <input
              className="input"
              type="number"
              min={1}
              max={16}
              value={parallel}
              onChange={e => setParallel(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
              style={{ maxWidth: 120 }}
            />
          </div>
        </div>

        {/* --- model overrides --- */}
        <div className="form-section">
          <div>
            <div className="form-section-head">Models <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></div>
            <div className="form-section-sub">Leave blank to use this provider's defaults.</div>
          </div>
          <div className="row-2">
            <div>
              <label className="label">Primary (per-file)</label>
              <input
                className="input"
                placeholder={providerInfo?.defaults.primary ?? ''}
                value={primaryModel}
                onChange={e => setPrimaryModel(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div>
              <label className="label">Secondary (verifier)</label>
              <input
                className="input"
                placeholder={providerInfo?.defaults.secondary ?? ''}
                value={secondaryModel}
                onChange={e => setSecondaryModel(e.target.value)}
                spellCheck={false}
              />
            </div>
          </div>
        </div>
      </div>

      {submitError && (
        <div className="error-banner" style={{ marginTop: 16 }}>
          <div><div className="err-title">Could not start scan</div><div className="muted">{submitError}</div></div>
        </div>
      )}

      <div className="row" style={{ marginTop: 22, justifyContent: 'flex-end', gap: 10 }}>
        <button type="button" className="btn ghost" onClick={() => navigate('/')}>Cancel</button>
        <button type="button" className="btn primary" disabled={!canSubmit} onClick={submit}>
          {submitting ? 'Starting…' : 'Start scan →'}
        </button>
      </div>
    </div>
  );
}
