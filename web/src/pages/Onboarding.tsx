import { SystemChecklist } from '../components/SystemCheck';
import { useState } from 'react';
import { api } from '../lib/api';

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async () => {
    setError(null);
    try {
      const r = await api<{ path: string | null }>('/api/workspace/pick', { method: 'POST' });
      if (r.path) setPath(r.path);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/workspace', { body: { path: path.trim() } });
      if (name.trim()) await api('/api/profile', { body: { name: name.trim() } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <form onSubmit={submit} className="panel" style={{ width: 'min(560px, 100%)', padding: 28, gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="brand-mark" aria-hidden="true">AB</span>
          <span className="eyebrow">Welcome to AI Brain · step 1 of 1</span>
        </div>
        <div>
          <h1 style={{ margin: '0 0 6px', fontSize: 24, fontWeight: 800 }}>Choose your workspace folder</h1>
          <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Everything AI Brain creates goes in this one folder: your vault, notes, projects and its database. Its agents cannot read or write
            anything outside it.
          </p>
        </div>
        <SystemChecklist />
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600 }}>
          Workspace folder
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input mono" style={{ flex: 1, fontSize: 13 }} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/Documents/AI Brain" required />
            <button type="button" className="btn" onClick={pick}>
              Choose…
            </button>
          </div>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600 }}>
          What should AI Brain call you?
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your first name" />
        </label>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          Creates <span className="mono">vault/</span>, <span className="mono">projects/</span> and <span className="mono">.ai-brain/</span> inside the folder. Existing files are left alone.
        </div>
        {error && <div className="error">{error}</div>}
        <button className="btn primary" style={{ height: 40 }} disabled={busy || !path.trim()}>
          {busy ? 'Setting up…' : 'Set up workspace'}
        </button>
      </form>
    </main>
  );
}
