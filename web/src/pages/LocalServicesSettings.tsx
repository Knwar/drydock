// Settings › Local services: database and other servers on your network that
// apps can use when they run on this Mac, plus limits for running apps.
import { useState } from 'react';
import { api, useApi } from '../lib/api';
import { Modal } from '../components/Dialogs';
import { when } from '../lib/time';
import type { ProjectSummary } from '../lib/types';

interface Service {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  tls: boolean;
  admin_user: string | null;
  secret: string | null;
  projects: string[] | null;
  max_databases: number;
  check: { ok: boolean; version?: string; error?: string; at: number } | null;
  databases: number;
}
interface Data {
  services: Service[];
  types: string[];
  ports: Record<string, number>;
  docker: boolean;
}

const TYPE_NAME: Record<string, string> = { postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB', mongodb: 'MongoDB', redis: 'Redis', rabbitmq: 'RabbitMQ', s3: 'S3-compatible (MinIO)', smtp: 'Mail catcher (SMTP)', other: 'Other' };
const isDb = (t: string) => ['postgres', 'mysql', 'mongodb'].includes(t);

export function LocalServicesSettings() {
  const d = useApi<Data>('/api/local-services', (m) => m?.type === 'local_services');
  const live = useApi<{ settings: { maxRunning: number; idleHours: number } }>('/api/live');
  const [editing, setEditing] = useState<Partial<Service> | null>(null);
  const [removing, setRemoving] = useState<Service | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [limits, setLimits] = useState<{ maxRunning: number; idleHours: number } | null>(null);
  if (!d.data) return null;
  const lim = limits ?? live.data?.settings ?? { maxRunning: 6, idleHours: 0 };

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ ok: true, text: ok });
      d.reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="settings-head">
        <div>
          <h1>Local services</h1>
          <p className="muted">Database and other servers on your network that apps can use when they run on this Mac. For each project Drydock creates its own database and a user that can reach only that one, and keeps the login in your password manager. It never touches databases it did not create. Without a matching server it uses Docker{d.data.docker ? '' : ' (not running right now)'}.</p>
        </div>
        <button className="btn primary" onClick={() => setEditing({ type: 'postgres', port: 5432, max_databases: 20 })}>Add a server</button>
      </div>
      {msg && <div className={msg.ok ? 'banner t-g' : 'error'}>{msg.text}</div>}

      <section className="panel">
        {d.data.services.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>No servers yet. Add your PostgreSQL, MySQL or MongoDB server, or a Redis, mail catcher or S3 store.</div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Server</th><th>Type</th><th>Address</th><th>Status</th><th>Drydock databases</th><th /></tr></thead>
              <tbody>
                {d.data.services.map((s) => (
                  <tr key={s.id}>
                    <td><strong>{s.name}</strong>{s.projects && <div className="muted" style={{ fontSize: 11.5 }}>{s.projects.length} project{s.projects.length === 1 ? '' : 's'} only</div>}</td>
                    <td>{TYPE_NAME[s.type] ?? s.type}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{s.host}:{s.port}{s.tls ? ' · TLS' : ''}</td>
                    <td>
                      {!s.check ? <span className="pill t-n">Not tested</span> : s.check.ok ? <span className="pill t-g" title={`Checked ${when(s.check.at)}`}>OK{s.check.version && s.check.version !== 'reachable' ? ` · ${s.check.version}` : ''}</span> : <span className="pill t-r" title={s.check.error}>Failed</span>}
                      {s.check && !s.check.ok && <div className="muted" style={{ fontSize: 11.5, maxWidth: 260 }}>{s.check.error}</div>}
                    </td>
                    <td>{isDb(s.type) ? `${s.databases} of ${s.max_databases}` : '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="link-btn" style={{ fontSize: 12, marginRight: 10 }} disabled={busy !== null} onClick={() => run(`test-${s.id}`, () => api(`/api/local-services/${s.id}/test`, { method: 'POST' }))}>{busy === `test-${s.id}` ? 'Testing…' : 'Test'}</button>
                      <button className="link-btn" style={{ fontSize: 12, marginRight: 10 }} onClick={() => setEditing(s)}>Edit</button>
                      <button className="link-btn" style={{ fontSize: 12, color: 'var(--r-fg)' }} onClick={() => setRemoving(s)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" style={{ maxWidth: 640 }}>
        <h2>Running apps</h2>
        <div className="form-grid">
          <label className="field"><span className="muted">At most this many apps at once</span><input className="input" type="number" min={1} max={30} value={lim.maxRunning} onChange={(e) => setLimits({ ...lim, maxRunning: Number(e.target.value) })} /></label>
          <label className="field"><span className="muted">Pause an app nobody opened for (hours, 0 = never)</span><input className="input" type="number" min={0} max={72} value={lim.idleHours} onChange={(e) => setLimits({ ...lim, idleHours: Number(e.target.value) })} /></label>
          <button className="btn sm" style={{ alignSelf: 'end' }} disabled={!limits || busy !== null} onClick={() => run('limits', () => api('/api/live/settings', { body: lim }).then(() => (setLimits(null), live.reload())), 'Saved.')}>Save</button>
        </div>
      </section>

      {editing && <ServiceDialog data={d.data} initial={editing} onClose={() => setEditing(null)} onSaved={(s) => (setEditing(null), d.reload(), setMsg(s.check?.ok ? { ok: true, text: `${s.name}: connected${s.check.version ? ` (${s.check.version})` : ''}.` } : { ok: false, text: `${s.name} was saved, but the connection test failed: ${s.check?.error ?? 'unknown error'}` }))} />}
      {removing && (
        <Modal title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)} width={460}>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>Drydock stops using this server for new databases. Nothing on the server is changed.{removing.databases ? ` It still has ${removing.databases} database(s) made by Drydock: reset them from their projects first.` : ''}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn danger" disabled={busy !== null || removing.databases > 0} onClick={() => run('remove', () => api(`/api/local-services/${removing.id}`, { method: 'DELETE' }), `Removed ${removing.name}.`).then(() => setRemoving(null))}>Yes, remove</button>
            <button className="btn" onClick={() => setRemoving(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function ServiceDialog({ data, initial, onClose, onSaved }: { data: Data; initial: Partial<Service>; onClose: () => void; onSaved: (s: Service) => void }) {
  const secrets = useApi<{ secrets: { name: string }[]; provider: string | null }>('/api/secrets');
  const projects = useApi<ProjectSummary[]>('/api/projects');
  const [f, setF] = useState<Partial<Service>>(initial);
  const [newSecret, setNewSecret] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const db = isDb(f.type ?? '');
  const set = <K extends keyof Service>(k: K, v: Service[K]) => setF({ ...f, [k]: v });
  const secretName = (f.name ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') + (db ? '_ADMIN_PASSWORD' : '_URL');

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      let secret = f.secret ?? null;
      if (newSecret) {
        await api('/api/secrets', { body: { name: secretName, value: newSecret, note: `${f.name}: ${db ? 'admin password' : 'connection URL'}` } });
        secret = secretName;
      }
      const s = await api<Service>('/api/local-services', { body: { ...f, secret } });
      onSaved(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={initial.id ? `Edit ${initial.name}` : 'Add a server'} onClose={onClose} width={560}>
      <div className="form-grid">
        <label className="field"><span className="muted">Name</span><input className="input" placeholder="NAS Postgres" value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field">
          <span className="muted">Type</span>
          <select className="input" value={f.type} disabled={Boolean(initial.id)} onChange={(e) => setF({ ...f, type: e.target.value, port: data.ports[e.target.value] || f.port })}>
            {data.types.map((t) => <option key={t} value={t}>{TYPE_NAME[t] ?? t}</option>)}
          </select>
        </label>
        <label className="field"><span className="muted">Host</span><input className="input mono" placeholder="nas.local or 192.168.1.20" value={f.host ?? ''} onChange={(e) => set('host', e.target.value.trim())} /></label>
        <label className="field"><span className="muted">Port</span><input className="input mono" type="number" value={f.port ?? ''} onChange={(e) => set('port', Number(e.target.value))} /></label>
      </div>
      {db && (
        <div className="form-grid">
          <label className="field"><span className="muted">Admin user (can create databases and users)</span><input className="input mono" placeholder={f.type === 'mysql' ? 'root' : f.type === 'mongodb' ? 'admin' : 'postgres'} value={f.admin_user ?? ''} onChange={(e) => set('admin_user', e.target.value)} /></label>
          <label className="field"><span className="muted">Databases Drydock may create here</span><input className="input" type="number" min={1} value={f.max_databases ?? 20} onChange={(e) => set('max_databases', Number(e.target.value))} /></label>
        </div>
      )}
      <label className="field">
        <span className="muted">{db ? 'Admin password' : 'Connection URL (with its password, if any)'}: a saved secret, or type it to save one</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select className="input" style={{ flex: '1 1 200px' }} value={f.secret ?? ''} disabled={Boolean(newSecret)} onChange={(e) => set('secret', e.target.value || null)}>
            <option value="">Choose a saved secret…</option>
            {(secrets.data?.secrets ?? []).map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
          <input className="input mono" style={{ flex: '1 1 200px' }} type="password" autoComplete="off" placeholder={secrets.data?.provider ? `or type it (saved as ${secretName})` : 'connect a password manager first'} disabled={!secrets.data?.provider} value={newSecret} onChange={(e) => setNewSecret(e.target.value)} />
        </div>
      </label>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={Boolean(f.tls)} onChange={(e) => set('tls', e.target.checked)} /> Use TLS</label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={Boolean(f.projects)} onChange={(e) => set('projects', e.target.checked ? [] : null)} /> Only for some projects</label>
      </div>
      {f.projects && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
          {(projects.data ?? []).map((p) => (
            <label key={p.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={f.projects!.includes(p.id)} onChange={(e) => set('projects', e.target.checked ? [...f.projects!, p.id] : f.projects!.filter((x) => x !== p.id))} /> {p.name}
            </label>
          ))}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" disabled={busy || !f.name || !f.host || (db && !f.admin_user) || (!f.secret && !newSecret && db)} onClick={save}>{busy ? 'Saving and testing…' : 'Save and test'}</button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
