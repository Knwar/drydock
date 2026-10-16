// The recommended-team popup: shown when a project's requirements are final.
// Core members (always: Architect, PM, QC, Security Champion) and specialists
// the Main agent suggests from the requirements; add one by one or all at once,
// then start the system design (with confirmation).
import { useState } from 'react';
import { api } from '../lib/api';
import { Modal } from './Dialogs';

export interface RecItem {
  key: string;
  template?: string | null;
  name: string;
  skill?: string | null;
  kind: 'core' | 'specialist';
  reason: string;
  required?: boolean;
  added: boolean;
}

export interface Recommendation {
  items: RecItem[];
  status: string;
  source: string;
  updated_at: number;
}

export function TeamPopup({ projectId, projectName, slug, rec, onClose, onStarted }: { projectId: string; projectName: string; slug: string; rec: Recommendation; onClose: () => void; onStarted: (channel: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const add = async (keys: string[]) => {
    setBusy(keys.length > 1 ? 'all' : keys[0]);
    setError(null);
    try {
      await api(`/api/projects/${projectId}/team`, { body: { keys } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const start = async () => {
    setBusy('start');
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/design/start`, { method: 'POST' });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error ?? res.statusText);
      onStarted(r.channel);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setConfirming(false);
    } finally {
      setBusy(null);
    }
  };
  const missing = rec.items.filter((i) => !i.added);
  const architectAdded = rec.items.some((i) => i.key === 'architect' && i.added);
  const tailoring = rec.source === 'baseline';
  return (
    <Modal title={`Recommended team for ${projectName}`} onClose={onClose} width={680}>
      {confirming ? (
        <>
          <div style={{ fontSize: 13 }}>Start the system design for <strong>{projectName}</strong>? This will:</div>
          <ul className="md-list" style={{ fontSize: 13, lineHeight: 1.55, margin: 0 }}>
            <li>Move the project to the Design stage.</li>
            <li>Brief the Architect in <strong>#{slug} › design</strong> to write the C4 system design.</li>
            {rec.items.some((i) => i.key === 'security' && i.added) && <li>Ask the Security Champion for a STRIDE threat model of the design.</li>}
            <li>Start agents working, which uses your subscription.</li>
          </ul>
          {error && <div className="error">{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={busy === 'start'} onClick={start}>{busy === 'start' ? 'Starting…' : 'Yes, start the design'}</button>
            <button className="btn" onClick={() => setConfirming(false)}>Back to the team</button>
          </div>
        </>
      ) : (
        <>
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
            Quality and security are always part of the team. {tailoring ? 'The Main agent is reading the requirements and may suggest specialists; this list updates when it does.' : 'The Main agent tailored this list to the requirements.'}
          </div>
          <div className="rec-list">
            {rec.items.map((i) => (
              <div key={i.key} className={`rec-row${i.added ? ' added' : ''}`}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 14 }}>{i.name}</strong>
                    <span className={`pill ${i.kind === 'core' ? 't-b' : 't-v'}`}>{i.kind}</span>
                    {i.required && <span className="pill t-n">always on</span>}
                    {i.skill && <span className="pill t-n mono" style={{ fontSize: 10.5 }}>skill: {i.skill}</span>}
                    {!i.template && <span className="pill t-a">new member</span>}
                  </div>
                  <span style={{ fontSize: 12.5, color: 'var(--text2)' }}>{i.reason}</span>
                </div>
                {i.added ? <span className="pill t-g">Added ✓</span> : <button className="btn sm" disabled={busy !== null} onClick={() => add([i.key])}>{busy === i.key ? 'Adding…' : 'Add'}</button>}
              </div>
            ))}
          </div>
          {error && <div className="error">{error}</div>}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn" disabled={busy !== null || missing.length === 0} onClick={() => add(missing.map((m) => m.key))}>{busy === 'all' ? 'Adding…' : missing.length ? `Add all (${missing.length})` : 'All added'}</button>
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={onClose}>Later</button>
            <button className="btn primary" disabled={!architectAdded} title={architectAdded ? undefined : 'Add the Architect first'} onClick={() => setConfirming(true)}>Start system design →</button>
          </div>
        </>
      )}
    </Modal>
  );
}
