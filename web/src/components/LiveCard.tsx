// "Running on this Mac": a project's app, its link, and Start / Pause /
// Resume / Stop. Everything else (installs, restarts after merges and
// crashes, databases) happens by itself; this card shows what it did.
import { useEffect, useState } from 'react';
import { api, useApi } from '../lib/api';
import { when } from '../lib/time';
import { Modal } from './Dialogs';

interface Live {
  status: 'stopped' | 'installing' | 'starting' | 'live' | 'paused' | 'crashed' | 'error' | 'needs_approval' | 'launched';
  message: string | null;
  kind: 'web' | 'app' | 'none' | null;
  recipe: 'file' | 'detected' | null;
  runnable: boolean;
  startedAt: number | null;
  needsApproval: string[];
  approved: string[];
  services: { name: string; primary: boolean; status: string; port: number | null; url: string }[];
  databases: { id: number; as: string; name: string; where: string; type: string }[];
}

const LABEL: Record<Live['status'], [string, string]> = {
  live: ['Live', 't-g'],
  starting: ['Starting…', 't-b'],
  installing: ['Installing…', 't-b'],
  paused: ['Paused', 't-a'],
  stopped: ['Stopped', 't-n'],
  crashed: ['Crashed', 't-r'],
  error: ['Needs attention', 't-r'],
  needs_approval: ['Waiting for you', 't-a'],
  launched: ['Opened', 't-g'],
};

export function LiveCard({ projectId }: { projectId: string }) {
  const live = useApi<Live>(`/api/projects/${projectId}/live`, (m) => m?.type === 'live' && m.project_id === projectId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approve, setApprove] = useState<string[] | null>(null);
  const [logs, setLogs] = useState(false);
  const [reset, setReset] = useState<Live['databases'][number] | null>(null);
  const l = live.data;
  if (!l) return null;

  const act = async (what: 'start' | 'pause' | 'resume' | 'stop', body?: unknown) => {
    setBusy(what);
    setError(null);
    try {
      const r = await api<any>(`/api/projects/${projectId}/live/${what}`, { method: 'POST', body });
      if (what === 'start' && r.status === 'needs_approval') setApprove(r.needsApproval);
      live.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const [label, tone] = LABEL[l.status];
  const primary = l.services.find((s) => s.primary);
  const running = ['live', 'starting', 'installing', 'crashed'].includes(l.status);
  const up = ['live', 'starting', 'installing', 'paused', 'crashed'].includes(l.status);

  return (
    <section className={`panel live-card live-${l.status}`} aria-label="Running on this Mac">
      <div className="panel-head" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
          <span className={`live-dot live-dot-${l.status}`} aria-hidden="true" />
          <h2 style={{ margin: 0 }}>On this Mac</h2>
          <span className={`pill ${tone}`}>{label}</span>
          {l.status === 'live' && l.startedAt && <span className="muted" style={{ fontSize: 12 }}>since {when(l.startedAt)}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {!up && l.kind !== 'app' && <button className="btn sm primary" disabled={!l.runnable || busy !== null} title={l.runnable ? undefined : 'No run recipe yet'} onClick={() => act('start')}>{busy === 'start' ? 'Starting…' : 'Start'}</button>}
          {l.kind === 'app' && <button className="btn sm primary" disabled={busy !== null} onClick={() => act('start')}>{busy === 'start' ? 'Building…' : 'Build and open'}</button>}
          {running && l.status !== 'crashed' && <button className="btn sm" disabled={busy !== null} onClick={() => act('pause')}>Pause</button>}
          {l.status === 'crashed' && <button className="btn sm primary" disabled={busy !== null} onClick={() => act('start')}>Restart</button>}
          {l.status === 'paused' && <button className="btn sm primary" disabled={busy !== null} onClick={() => act('resume')}>Resume</button>}
          {up && <button className="btn sm" disabled={busy !== null} onClick={() => act('stop')}>Stop</button>}
          {l.runnable && <button className="btn sm" onClick={() => setLogs(true)}>Log</button>}
        </div>
      </div>

      {l.kind === 'web' && primary && (
        <div className="live-links">
          {l.services.map((s) => (
            <a key={s.name} className={`live-link${s.primary ? ' primary' : ''}`} href={s.url} target="_blank" rel="noreferrer" aria-disabled={l.status !== 'live'}>
              <span className="mono">{s.url.replace(/^http:\/\//, '')}</span>
              {l.services.length > 1 && <span className="muted" style={{ fontSize: 11.5 }}>{s.name}{s.status !== 'live' && up ? ` · ${s.status}` : ''}</span>}
              <span aria-hidden="true">↗</span>
            </a>
          ))}
        </div>
      )}

      {!l.runnable && (
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
          {l.message ?? 'Not runnable yet.'} The developer adds a run recipe (<span className="mono">.ai-brain/run.json</span>) while building; common setups (Vite, Next.js, Flutter web, Django) are detected on their own.
        </div>
      )}
      {l.runnable && l.message && l.status !== 'live' && <div className={l.status === 'error' || l.status === 'crashed' ? 'error' : 'muted'} style={{ fontSize: 12.5 }}>{l.message}</div>}
      {error && <div className="error">{error}</div>}

      {(l.databases.length > 0 || l.recipe) && (
        <div className="live-meta">
          {l.databases.map((d) => (
            <span key={d.id} className="live-db">
              <span className="mono">{d.as}</span> · {d.type} on {d.where} · <span className="mono">{d.name}</span>
              <button className="link-btn" style={{ fontSize: 11.5, color: 'var(--r-fg)' }} onClick={() => setReset(d)}>Reset</button>
            </span>
          ))}
          {l.recipe && <span className="muted">{l.recipe === 'file' ? 'Runs from .ai-brain/run.json' : 'Run setup detected automatically'} · restarts on each merge</span>}
        </div>
      )}

      {approve && (
        <Modal title="Let this app use these secrets?" onClose={() => setApprove(null)} width={480}>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>When it runs, the app gets these as environment variables. It keeps using them on automatic restarts; it asks again if it needs new ones.</div>
          <ul className="md-list" style={{ margin: 0 }}>{approve.map((n) => <li key={n} className="mono" style={{ fontSize: 12.5 }}>{n}</li>)}</ul>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={busy !== null} onClick={() => act('start', { approve }).then(() => setApprove(null))}>Allow and start</button>
            <button className="btn" onClick={() => setApprove(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {logs && <LogDialog projectId={projectId} onClose={() => setLogs(false)} />}
      {reset && (
        <Modal title={`Reset ${reset.name}?`} onClose={() => setReset(null)} width={480}>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>The app stops, AI Brain backs the database up into the workspace if it can, then deletes it and its user. The next start creates an empty one and runs the setup step (migrations) again.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn danger"
              disabled={busy !== null}
              onClick={async () => {
                setBusy('reset');
                try {
                  const r = await api<{ backup: { file: string | null; reason?: string } }>(`/api/projects/${projectId}/databases/${reset.id}/reset`, { method: 'POST' });
                  setError(r.backup.file ? `Reset. Backup: ${r.backup.file}` : `Reset. No backup was made: ${r.backup.reason}.`);
                  setReset(null);
                  live.reload();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              Yes, reset it
            </button>
            <button className="btn" onClick={() => setReset(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function LogDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [text, setText] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () => api<{ log: string }>(`/api/projects/${projectId}/live/logs?lines=400`).then((r) => alive && setText(r.log)).catch(() => undefined);
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [projectId]);
  return (
    <Modal title="Log" onClose={onClose} width={860}>
      <pre className="md-pre live-log" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>{text || 'No output yet.'}</pre>
    </Modal>
  );
}

/** Header indicator: how many apps are running on this Mac. */
export function LiveCount() {
  const l = useApi<{ apps: { project_id: string; name: string; status: string }[] }>('/api/live', (m) => m?.type === 'live');
  const apps = l.data?.apps ?? [];
  if (!apps.length) return null;
  const crashed = apps.some((a) => a.status === 'crashed');
  return (
    <span className={`pill ${crashed ? 't-r' : 't-g'} live-count`} title={apps.map((a) => `${a.name}: ${a.status}`).join('\n')}>
      <span className="live-dot live-dot-live" aria-hidden="true" /> {apps.length} running
    </span>
  );
}
