// Settings › Secrets: connect a password manager (1Password, Bitwarden on
// Vaultwarden, or Bitwarden Secrets Manager), and see/add/rotate/delete the
// secrets agents can use. Values are typed in here and go straight to the
// manager; nothing on this page ever shows one.
import { useState } from 'react';
import { api, useApi } from '../lib/api';
import { Modal } from '../components/Dialogs';
import { when } from '../lib/time';
import type { ProjectSummary } from '../lib/types';

type Provider = '1password' | 'bitwarden' | 'bws';
interface Status {
  installed: boolean;
  ready: boolean;
  detail: string;
  unlocked?: boolean;
  unlockedUntil?: number | null;
  account?: string | null;
  projects?: { id: string; name: string }[];
}
interface Secret {
  name: string;
  project_id: string | null;
  provider: Provider;
  kind: 'generated' | 'provided';
  note: string | null;
  rotated_at: number;
  used_at: number | null;
}
interface Data {
  provider: Provider | null;
  settings: {
    confirmOnMac: boolean;
    onepassword: { vault: string; account: string | null; askEveryTime: boolean };
    bitwarden: { server: string | null; folder: string; unlockMinutes: number };
    bws: { serverUrl: string | null; projectId: string | null };
  };
  onepassword: Status;
  bitwarden: Status;
  bws: Status;
  secrets: Secret[];
}

const NAMES: Record<Provider, string> = { '1password': '1Password', bitwarden: 'Bitwarden (Vaultwarden)', bws: 'Bitwarden Secrets Manager' };
const BLURB: Record<Provider, string> = {
  '1password': 'Your 1Password account, through the 1Password CLI. Secrets go to one vault.',
  bitwarden: 'Your self-hosted Vaultwarden, through the Bitwarden CLI. You unlock it with your master password for a set time.',
  bws: 'Bitwarden’s product for machines: a machine-account token, one project. Needs Bitwarden cloud or the official self-hosted server (not Vaultwarden).',
};

const BREW: Partial<Record<Provider, string>> = { '1password': 'brew install --cask 1password-cli', bitwarden: 'brew install bitwarden-cli' };

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return <button role="switch" aria-checked={on} aria-label={label} className="switch" onClick={() => onChange(!on)}><span /></button>;
}

export function SecretsSettings() {
  const d = useApi<Data>('/api/secrets', (m) => m?.type === 'secrets');
  const projects = useApi<ProjectSummary[]>('/api/projects');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'delete' | 'rotate'; name: string } | null>(null);
  const [install, setInstall] = useState<Provider | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const data = d.data;
  if (!data) return <div className="muted">Checking your password managers…</div>;
  const s = data.settings;
  const field = (k: string, fallback: string) => form[k] ?? fallback;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

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
  const saveSettings = (body: unknown, ok = 'Saved.') => run('settings', () => api('/api/secrets/settings', { body }), ok);

  const providerCard = (p: Provider) => {
    const st = data[p === '1password' ? 'onepassword' : p];
    const chosen = data.provider === p;
    return (
      <section key={p} className="panel" style={{ flex: '1 1 280px', borderColor: chosen ? 'var(--accent)' : undefined }}>
        <div className="panel-head">
          <h2>{NAMES[p]}</h2>
          {chosen && st.ready ? (
            <span className="pill t-b">In use</span>
          ) : chosen ? (
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="pill t-a">Chosen, not set up</span>
              <button className="link-btn" style={{ fontSize: 12 }} disabled={busy !== null} onClick={() => saveSettings({ provider: null }, `${NAMES[p]} is no longer chosen.`)}>Undo</button>
            </span>
          ) : (
            <button className="btn sm" disabled={busy !== null || !st.installed} title={st.installed ? undefined : 'Install it first'} onClick={() => saveSettings({ provider: p }, `${NAMES[p]} is now where new secrets go.`)}>Use this</button>
          )}
        </div>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>{BLURB[p]}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
          <span className={`pill ${!st.installed ? 't-r' : st.ready ? 't-g' : 't-a'}`}>{!st.installed ? 'Not installed' : st.ready ? (p === 'bitwarden' && !st.unlocked ? 'Locked' : 'Ready') : 'Needs setup'}</span>
          <span style={{ color: 'var(--text2)' }}>{st.detail}</span>
        </div>
        {!st.installed && BREW[p] && (
          <button className="btn sm primary" style={{ alignSelf: 'flex-start' }} disabled={busy !== null} onClick={() => setInstall(p)}>{busy === `install-${p}` ? 'Installing…' : 'Install it'}</button>
        )}
        {!st.installed && p === 'bws' && (
          <a className="btn sm" style={{ alignSelf: 'flex-start' }} href="https://github.com/bitwarden/sdk-sm/releases" target="_blank" rel="noreferrer">Download page</a>
        )}

        {p === '1password' && st.installed && (
          <div className="form-grid">
            <label className="field"><span className="muted">Vault</span><input className="input" value={field('opVault', s.onepassword.vault)} onChange={set('opVault')} /></label>
            <label className="field"><span className="muted">Account (optional)</span><input className="input" placeholder="my.1password.com" value={field('opAccount', s.onepassword.account ?? '')} onChange={set('opAccount')} /></label>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12.5 }}>
              <Switch on={s.onepassword.askEveryTime} label="Re-authorize every time" onChange={(v) => saveSettings({ onepassword: { ...s.onepassword, askEveryTime: v } })} />
              Re-authorize 1Password every time (otherwise it stays authorized for about 10 minutes)
            </label>
            <button className="btn sm" style={{ alignSelf: 'end' }} disabled={busy !== null} onClick={() => saveSettings({ onepassword: { ...s.onepassword, vault: field('opVault', s.onepassword.vault), account: field('opAccount', s.onepassword.account ?? '') || null } })}>Save</button>
          </div>
        )}

        {p === 'bitwarden' && st.installed && (
          <div className="form-grid">
            <label className="field"><span className="muted">Vaultwarden server</span><input className="input" placeholder="https://vault.example.com" value={field('bwServer', s.bitwarden.server ?? '')} onChange={set('bwServer')} /></label>
            <button className="btn sm" style={{ alignSelf: 'end' }} disabled={busy !== null || !field('bwServer', s.bitwarden.server ?? '')} onClick={() => run('server', () => api('/api/secrets/bitwarden/server', { body: { server: field('bwServer', '') } }), 'Server saved. Now sign the CLI in once in a terminal: bw login')}>Save server</button>
            <label className="field"><span className="muted">Folder</span><input className="input" value={field('bwFolder', s.bitwarden.folder)} onChange={set('bwFolder')} /></label>
            <label className="field"><span className="muted">Stay unlocked (minutes)</span><input className="input" type="number" min={1} max={240} value={field('bwMinutes', String(s.bitwarden.unlockMinutes))} onChange={set('bwMinutes')} /></label>
            <button className="btn sm" style={{ alignSelf: 'end' }} disabled={busy !== null} onClick={() => saveSettings({ bitwarden: { folder: field('bwFolder', s.bitwarden.folder), unlockMinutes: Number(field('bwMinutes', String(s.bitwarden.unlockMinutes))) } })}>Save</button>
            {st.ready && (st.unlocked ? (
              <button className="btn sm" style={{ alignSelf: 'end' }} onClick={() => run('lock', () => api('/api/secrets/bitwarden/lock', { method: 'POST' }), 'Locked.')}>Lock now</button>
            ) : (
              <form className="field" onSubmit={(e) => (e.preventDefault(), run('unlock', () => api('/api/secrets/bitwarden/unlock', { body: { password: form.bwPassword ?? '' } }).then(() => setForm({ ...form, bwPassword: '' })), 'Unlocked.'))}>
                <span className="muted">Master password</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="input" type="password" autoComplete="off" style={{ flex: 1 }} value={form.bwPassword ?? ''} onChange={set('bwPassword')} />
                  <button className="btn sm primary" disabled={busy !== null || !form.bwPassword}>{busy === 'unlock' ? 'Unlocking…' : 'Unlock'}</button>
                </div>
              </form>
            ))}
          </div>
        )}

        {p === 'bws' && st.installed && (
          <div className="form-grid">
            <form className="field" onSubmit={(e) => (e.preventDefault(), run('token', () => api('/api/secrets/bws/token', { body: { token: form.bwsToken ?? '' } }).then(() => setForm({ ...form, bwsToken: '' })), 'Token saved to your Keychain.'))}>
              <span className="muted">Machine account access token</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="input" type="password" autoComplete="off" style={{ flex: 1 }} value={form.bwsToken ?? ''} onChange={set('bwsToken')} />
                <button className="btn sm" disabled={busy !== null || !form.bwsToken}>Save</button>
              </div>
            </form>
            {st.projects && (
              <label className="field">
                <span className="muted">Project for new secrets</span>
                <select className="input" value={s.bws.projectId ?? ''} onChange={(e) => saveSettings({ bws: { ...s.bws, projectId: e.target.value || null } })}>
                  <option value="">Choose…</option>
                  {st.projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </label>
            )}
            <label className="field"><span className="muted">Server (only if not bitwarden.com US)</span><input className="input" placeholder="https://vault.bitwarden.eu" value={field('bwsUrl', s.bws.serverUrl ?? '')} onChange={set('bwsUrl')} onBlur={() => form.bwsUrl !== undefined && saveSettings({ bws: { ...s.bws, serverUrl: form.bwsUrl || null } })} /></label>
          </div>
        )}
      </section>
    );
  };

  const projectName = (id: string | null) => (id ? projects.data?.find((p) => p.id === id)?.name ?? 'a project' : 'All projects');

  return (
    <>
      <div className="settings-head">
        <div>
          <h1>Secrets</h1>
          <p className="muted">API keys, passwords and signing keys live in your password manager. Agents only see their names: they ask you before a command uses one, and the output comes back with the values blanked out.</p>
        </div>
      </div>
      {msg && <div className={msg.ok ? 'banner t-g' : 'error'}>{msg.text}</div>}
      <div className="row">{(['1password', 'bitwarden', 'bws'] as Provider[]).map(providerCard)}</div>

      <section className="panel" style={{ maxWidth: 720 }}>
        <label style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 13 }}>
          <Switch on={s.confirmOnMac} label="Also confirm with Touch ID" onChange={(v) => saveSettings({ confirmOnMac: v })} />
          <span><strong>Also confirm with Touch ID</strong> <span className="muted">(or your Mac password) each time an agent uses a secret, after you approve its card.</span></span>
        </label>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Saved secrets</h2>
          <button className="btn sm primary" disabled={!data.provider} title={data.provider ? undefined : 'Choose a password manager first'} onClick={() => setAdding(true)}>Add a secret</button>
        </div>
        {data.secrets.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>None yet. Agents save new ones as they find or need them, or add one here.</div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Name</th><th>Where</th><th>Project</th><th>Kind</th><th>Changed</th><th>Last used</th><th /></tr></thead>
              <tbody>
                {data.secrets.map((x) => (
                  <tr key={x.name}>
                    <td><span className="mono" style={{ fontSize: 12.5 }}>{x.name}</span>{x.note && <div className="muted" style={{ fontSize: 11.5 }}>{x.note}</div>}</td>
                    <td>{NAMES[x.provider]}</td>
                    <td>{projectName(x.project_id)}</td>
                    <td><span className={`pill ${x.kind === 'generated' ? 't-v' : 't-n'}`}>{x.kind === 'generated' ? 'Generated' : 'From a service'}</span></td>
                    <td>{when(x.rotated_at)}</td>
                    <td>{x.used_at ? when(x.used_at) : '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {x.kind === 'generated' && <button className="link-btn" style={{ fontSize: 12, marginRight: 10 }} onClick={() => setConfirm({ kind: 'rotate', name: x.name })}>Rotate</button>}
                      <button className="link-btn" style={{ fontSize: 12, color: 'var(--r-fg)' }} onClick={() => setConfirm({ kind: 'delete', name: x.name })}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {adding && <AddSecretDialog projects={projects.data ?? []} onClose={() => setAdding(false)} onSaved={() => (setAdding(false), d.reload())} />}
      {install && (
        <Modal title={`Install ${NAMES[install]}?`} onClose={() => setInstall(null)} width={480}>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            Drydock runs <span className="mono">{BREW[install]}</span> on this Mac with Homebrew. It takes a minute or two.
            {install === '1password' && ' Afterwards, open the 1Password app and turn on Settings › Developer › Integrate with 1Password CLI.'}
            {install === 'bitwarden' && ' Afterwards, enter your Vaultwarden server here and sign the CLI in once in a terminal: bw login.'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={() => { const p = install; setInstall(null); run(`install-${p}`, () => api('/api/secrets/install', { body: { provider: p } }), `${NAMES[p]} CLI installed.`); }}>Yes, install</button>
            <button className="btn" onClick={() => setInstall(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {confirm && (
        <Modal title={confirm.kind === 'delete' ? `Delete ${confirm.name}?` : `Rotate ${confirm.name}?`} onClose={() => setConfirm(null)} width={480}>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            {confirm.kind === 'delete'
              ? 'It is archived in 1Password, moved to the trash in Bitwarden, or deleted in Secrets Manager, and agents can no longer use it.'
              : 'A new random value replaces the old one. Anything still using the old value (a running app, a deployed service) stops working until it is restarted with the new one.'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className={`btn ${confirm.kind === 'delete' ? 'danger' : 'primary'}`}
              disabled={busy !== null}
              onClick={() =>
                run(confirm.kind, () => (confirm.kind === 'delete' ? api(`/api/secrets/${confirm.name}`, { method: 'DELETE' }) : api(`/api/secrets/${confirm.name}/rotate`, { method: 'POST' })), confirm.kind === 'delete' ? `Deleted ${confirm.name}.` : `Rotated ${confirm.name}.`).then(() => setConfirm(null))
              }
            >
              {confirm.kind === 'delete' ? 'Yes, delete' : 'Yes, rotate'}
            </button>
            <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Paste a key from a service, or generate one. Also used by the request card in chat (fixed name). */
export function AddSecretDialog({ projects, onClose, onSaved, preset }: { projects: { id: string; name: string }[]; onClose: () => void; onSaved: () => void; preset?: { name: string; project_id: string | null; request: number; purpose?: string; url?: string | null } }) {
  const [name, setName] = useState(preset?.name ?? '');
  const [mode, setMode] = useState<'paste' | 'generate'>('paste');
  const [value, setValue] = useState('');
  const [project, setProject] = useState(preset?.project_id ?? '');
  const [note, setNote] = useState(preset?.purpose ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = /^[A-Z][A-Z0-9_]{1,63}$/.test(name) && (mode === 'generate' || value.length > 0);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/secrets', { body: { name, ...(mode === 'generate' ? { generate: { bytes: 32 } } : { value }), project_id: project || null, note: note || null, request: preset?.request } });
      setValue('');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={preset ? `Add ${preset.name}` : 'Add a secret'} onClose={onClose} width={520}>
      {preset?.url && <div style={{ fontSize: 13 }}>Get it here: <a href={preset.url} target="_blank" rel="noreferrer">{preset.url}</a></div>}
      {!preset && (
        <div className="seg" style={{ alignSelf: 'flex-start' }}>
          <button aria-pressed={mode === 'paste'} onClick={() => setMode('paste')}>Paste a key</button>
          <button aria-pressed={mode === 'generate'} onClick={() => setMode('generate')}>Generate a random one</button>
        </div>
      )}
      <label className="field"><span className="muted">Name (an env var name)</span><input className="input mono" value={name} disabled={Boolean(preset)} placeholder="STRIPE_API_KEY" onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} /></label>
      {mode === 'paste' && <label className="field"><span className="muted">Value</span><input className="input mono" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} /></label>}
      {!preset && (
        <label className="field">
          <span className="muted">Project</span>
          <select className="input" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
      <label className="field"><span className="muted">What it is for (optional)</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {error && <div className="error">{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" disabled={!valid || busy} title={valid ? undefined : 'Enter an UPPER_SNAKE name and a value'} onClick={save}>{busy ? 'Saving…' : 'Save to your password manager'}</button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
