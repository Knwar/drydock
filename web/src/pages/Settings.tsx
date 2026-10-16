import { useEffect, useState } from 'react';
import { api, useApi } from '../lib/api';
import { go, href } from '../lib/router';
import type { Role, WorkspaceInfo } from '../lib/types';
import { AddMemberDialog, Modal } from '../components/Dialogs';

const SECTIONS = [
  ['integrations', 'Integrations'],
  ['daily', 'The Daily'],
  ['team', 'Team & permissions'],
  ['usage', 'Usage alerts'],
  ['checkins', 'Check-ins'],
  ['workspace', 'Workspace'],
] as const;

type Policy = 'allow' | 'ask' | 'deny';
const NEXT: Record<Policy, Policy> = { ask: 'allow', allow: 'deny', deny: 'ask' };
const POLICY_LABEL: Record<Policy, string> = { allow: 'Allow', ask: 'Ask', deny: 'Never' };
const POLICY_TONE: Record<Policy, string> = { allow: 't-g', ask: 't-a', deny: 't-r' };

interface Server {
  name: string;
  prefix: string;
  url: string;
  status: string;
  detail: string;
  roles: { id: string; name: string; allowed: boolean }[];
  tools: { name: string; policy: Policy }[];
  policy: Policy;
}

const STATUS: Record<string, [string, string]> = {
  connected: ['Connected', 't-g'],
  built_in: ['Built in', 't-b'],
  needs_auth: ['Needs sign-in', 't-a'],
  failed: ['Failed', 't-r'],
  not_configured: ['Not configured', 't-n'],
};

function PolicyButton({ tool, policy, onDone }: { tool: string; policy: Policy; onDone: () => void }) {
  return (
    <button className={`pill ${POLICY_TONE[policy]}`} style={{ border: 0, minWidth: 64, height: 26 }} onClick={async () => { await api('/api/integrations/policy', { body: { tool, policy: NEXT[policy] } }); onDone(); }} title="Click to change: Ask → Allow → Never">
      {POLICY_LABEL[policy]}
    </button>
  );
}

function Integrations() {
  const [refresh, setRefresh] = useState(0);
  const data = useApi<{ servers: Server[] }>(`/api/integrations${refresh ? '?refresh=1&n=' + refresh : ''}`, () => false);
  const [sel, setSel] = useState<string>('');
  const servers = data.data?.servers ?? [];
  const s = servers.find((x) => x.prefix === sel) ?? servers.find((x) => x.status === 'connected') ?? servers[0];
  return (
    <>
      <div className="settings-head">
        <div>
          <h1>Integrations</h1>
          <p className="muted">MCP servers your agents can use. A role uses a server only if it has access here, and every tool call follows its policy: Allow runs without asking, Ask shows an approval card, Never blocks it.</p>
        </div>
        <button className="btn" onClick={() => setRefresh((n) => n + 1)} disabled={!data.data && !data.error}>{data.data ? 'Check again' : 'Checking servers…'}</button>
      </div>
      {!data.data && !data.error && <div className="muted">Asking Claude Code for its MCP servers (this health-checks each one and can take up to a minute)…</div>}
      {data.data && (
        <div className="row">
          <div style={{ flex: '1.3 1 420px', minWidth: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
            {servers.map((x) => {
              const [label, tone] = STATUS[x.status] ?? [x.status, 't-n'];
              return (
                <button key={x.prefix} className={`server${s?.prefix === x.prefix ? ' on' : ''}`} onClick={() => setSel(x.prefix)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                    <span style={{ flex: 1, fontWeight: 700, fontSize: 13.5, textAlign: 'left' }}>{x.name.replace(/^claude\.ai /, '').replace(/^plugin:[^:]+:/, '')}</span>
                    <span className={`pill ${tone}`}>{label}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 11.5, textAlign: 'left' }}>{x.name.startsWith('claude.ai') ? 'claude.ai connector' : x.name.startsWith('plugin:') ? x.name.split(':').slice(0, 2).join(':') : x.url}</div>
                  <div className="muted" style={{ fontSize: 11, textAlign: 'left' }}>{x.roles.filter((r) => r.allowed).length} roles · {x.tools.length} tools seen</div>
                </button>
              );
            })}
          </div>
          {s && (
            <aside className="panel" style={{ flex: '1 1 320px', minWidth: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 800 }}>{s.name}</div>
              <div className="muted mono" style={{ fontSize: 11.5 }}>{s.prefix}</div>
              <div style={{ fontSize: 13 }}>{s.detail}</div>
              {s.status === 'needs_auth' && (
                <div className="banner t-a" style={{ fontSize: 12.5 }}>Sign in once: run <span className="mono">claude</span> in a terminal, type <span className="mono">/mcp</span>, pick this server and follow the browser sign-in.</div>
              )}
              {s.status !== 'built_in' && (
                <>
                  <div className="eyebrow" style={{ fontWeight: 700 }}>Who can use it</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {s.roles.map((r) => (
                      <button key={r.id} className={`chip${r.allowed ? ' on' : ''}`} aria-pressed={r.allowed} onClick={async () => { await api('/api/integrations/access', { body: { role: r.id, server: s.prefix, allowed: !r.allowed } }); data.reload(); }}>
                        {r.allowed ? '✓ ' : '+ '}{r.name}
                      </button>
                    ))}
                  </div>
                  <div className="field" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>All tools of this server</span>
                    <PolicyButton tool={s.prefix} policy={s.policy} onDone={data.reload} />
                  </div>
                </>
              )}
              <div className="eyebrow" style={{ fontWeight: 700 }}>Tools</div>
              {s.tools.length === 0 ? (
                <div className="muted" style={{ fontSize: 12.5 }}>{s.status === 'built_in' ? 'Always available to the roles that need them.' : 'Tools appear here after an agent first uses this server. Then you can set each one.'}</div>
              ) : (
                s.tools.map((t) => (
                  <div key={t.name} className="check-row">
                    <span className="mono" style={{ flex: 1, fontSize: 12 }}>{t.name.split('__').pop()}</span>
                    <PolicyButton tool={t.name} policy={t.policy} onDone={data.reload} />
                  </div>
                ))
              )}
            </aside>
          )}
        </div>
      )}
    </>
  );
}

interface DailySettings { time: string; days: number[]; email: boolean; push: boolean; audio: boolean; sections: Record<string, boolean> }

function Switch({ on, label, onChange, locked }: { on: boolean; label: string; onChange: (v: boolean) => void; locked?: boolean }) {
  return <button role="switch" aria-checked={on} aria-label={label} className="switch" disabled={locked} onClick={() => onChange(!on)}><span /></button>;
}

function DailySettingsPage() {
  const d = useApi<{ settings: DailySettings; edition: any; generating: boolean }>('/api/daily', (m) => m?.type === 'daily');
  const [error, setError] = useState<string | null>(null);
  const s = d.data?.settings;
  if (!s) return null;
  const save = async (patch: Partial<DailySettings>) => {
    setError(null);
    try {
      await api('/api/daily/settings', { body: patch });
      d.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const rows = (items: [string, string, string, boolean?][], get: (k: string) => boolean, set: (k: string, v: boolean) => void) =>
    items.map(([k, label, desc, locked]) => (
      <div key={k} className="switch-row">
        <span style={{ flex: 1 }}><strong style={{ fontSize: 13.5 }}>{label}</strong><br /><span className="muted" style={{ fontSize: 12 }}>{desc}</span></span>
        <Switch on={get(k)} label={label} locked={locked} onChange={(v) => set(k, v)} />
      </div>
    ));
  return (
    <>
      <div className="settings-head"><div><h1>The Daily</h1><p className="muted">When your morning edition is written, where it goes, and what is in it. You can change these any time.</p></div></div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <div style={{ flex: '1.3 1 420px', display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <section className="panel">
            <h2>Schedule</h2>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }} className="muted">Publish at
                <input type="time" className="input mono" value={s.time} onChange={(e) => save({ time: e.target.value })} />
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="muted" style={{ fontSize: 12 }}>On these days</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {days.map((label, i) => (
                    <button key={label} aria-pressed={s.days.includes(i)} className={`day-btn${s.days.includes(i) ? ' on' : ''}`} onClick={() => save({ days: s.days.includes(i) ? s.days.filter((x) => x !== i) : [...s.days, i] })}>{label.slice(0, 2)}</button>
                  ))}
                </div>
              </div>
            </div>
          </section>
          <section className="panel">
            <h2>Delivery</h2>
            {rows(
              [
                ['inapp', 'In the app', 'Always on: Home and your Personal page.', true],
                ['email', 'Email', 'The main agent emails it to you with Gmail. The first send asks for your approval.'],
                ['push', 'Push notification', 'A one-line notification on this Mac.'],
                ['audio', 'Audio version', 'A spoken edition you can play, made with macOS speech.'],
              ],
              (k) => (k === 'inapp' ? true : Boolean((s as any)[k])),
              (k, v) => save({ [k]: v } as any),
            )}
          </section>
          <section className="panel">
            <h2>Sections in each edition</h2>
            {rows(
              [
                ['day', 'Your day', 'Meetings, focus time and reminders'],
                ['work', 'Work & projects', 'Overnight progress, blockers, gates waiting for you'],
                ['inbox', 'Inbox highlights', 'Emails that need action'],
                ['life', 'Life & money', 'Bills, spending, birthdays, personal threads'],
                ['team', 'Team decisions', 'What your team agreed since the last edition'],
              ],
              (k) => Boolean(s.sections[k]),
              (k, v) => save({ sections: { ...s.sections, [k]: v } } as any),
            )}
          </section>
        </div>
        <aside className="panel" style={{ flex: '1 1 300px', minWidth: 0 }}>
          <h2>Latest edition</h2>
          {d.data?.edition ? (
            <>
              <div className="eyebrow">Edition {d.data.edition.number} · {d.data.edition.day}</div>
              <div style={{ fontWeight: 800, fontSize: 16 }}>{d.data.edition.headline}</div>
              <div className="muted" style={{ fontSize: 13 }}>{d.data.edition.summary}</div>
            </>
          ) : (
            <div className="muted" style={{ fontSize: 13 }}>None yet.</div>
          )}
          <button className="btn primary" disabled={d.data?.generating} onClick={() => api('/api/daily/generate', { method: 'POST' }).then(d.reload)}>{d.data?.generating ? 'Writing…' : 'Write an edition now'}</button>
        </aside>
      </div>
    </>
  );
}

function MemberLearnings({ roleId }: { roleId: string }) {
  const l = useApi<{ active: { id: number; rule: string; count: number }[]; all: { id: number; rule: string; count: number }[] }>(`/api/roles/${roleId}/learnings`, (m) => m?.type === 'memory');
  const [removing, setRemoving] = useState<{ id: number; rule: string } | null>(null);
  if (!l.data) return null;
  const candidates = l.data.all.filter((x) => !l.data!.active.some((a) => a.id === x.id));
  return (
    <div className="field" style={{ gap: 6 }}>
      <span className="muted">Learnings ({l.data.active.length}/15): added to this member's instructions when they repeat a mistake</span>
      {l.data.active.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>None yet.</span>}
      {l.data.active.map((x) => (
        <div key={x.id} className="check-row" style={{ padding: '4px 0' }}>
          <span style={{ flex: 1, fontSize: 12.5 }}>{x.rule}</span>
          <span className="mono muted" style={{ fontSize: 11 }}>×{x.count}</span>
          <button className="link-btn" style={{ color: 'var(--r-fg)', fontSize: 12 }} onClick={() => setRemoving(x)}>Remove</button>
        </div>
      ))}
      {candidates.length > 0 && <span className="muted" style={{ fontSize: 11.5 }}>{candidates.length} mistake{candidates.length > 1 ? 's' : ''} seen once (become learnings if repeated).</span>}
      {removing && (
        <Modal title="Remove this learning?" onClose={() => setRemoving(null)} width={460}>
          <div style={{ fontSize: 13 }}>“{removing.rule}” is removed from this member's instructions. If the mistake happens again it is counted afresh.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn danger" onClick={async () => { await api(`/api/learnings/${removing.id}`, { method: 'DELETE' }); setRemoving(null); l.reload(); }}>Yes, remove</button>
            <button className="btn" onClick={() => setRemoving(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RoleEditor({ role, onClose }: { role: Partial<Role> | null; onClose: () => void }) {
  const [form, setForm] = useState<Partial<Role>>(role ?? {});
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    setForm(role ?? {});
    setConfirming(false);
  }, [role]);
  if (!role) return null;
  const set = (k: keyof Role, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    try {
      await api('/api/roles', { body: form });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="panel" aria-label="Edit role">
      <div className="panel-head"><h2>{role.id ? `Edit ${role.name}` : 'New role'}</h2><button className="btn sm" onClick={onClose}>Close</button></div>
      <div className="form-grid">
        <label>Name<input className="input" value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} /></label>
        <label>Scope<select className="input" value={form.scope ?? 'shared'} onChange={(e) => set('scope', e.target.value)}><option value="shared">Shared · all projects</option><option value="project">Per project</option><option value="global">Global</option></select></label>
        <label>Model<select className="input" value={form.model ?? 'sonnet'} onChange={(e) => set('model', e.target.value)}><option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option></select></label>
        <label>Skill<input className="input mono" placeholder="e.g. marketing:campaign-plan" value={form.skill ?? ''} onChange={(e) => set('skill', e.target.value)} /></label>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }} className="muted">Persona (system prompt)
        <textarea className="input" rows={8} style={{ fontSize: 13, color: 'var(--text)' }} value={form.persona ?? ''} onChange={(e) => set('persona', e.target.value)} placeholder="Who this team member is and how they work…" />
      </label>
      {role.id && <MemberLearnings roleId={role.id} />}
      {error && <div className="error">{error}</div>}
      {confirming ? (
        <div className="confirm" role="alertdialog" aria-labelledby="rm-title" aria-describedby="rm-desc">
          <strong id="rm-title">Remove {role.name} from your team?</strong>
          <span id="rm-desc" className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            They leave every channel, anything they are working on now is stopped, and their standing permissions and integration access are cleared. Your chat history with them is kept. If you add them again, they start with a fresh memory.
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn danger"
              disabled={removing}
              autoFocus
              onClick={async () => {
                setRemoving(true);
                try {
                  await api(`/api/roles/${role.id}`, { method: 'DELETE' });
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                  setConfirming(false);
                } finally {
                  setRemoving(false);
                }
              }}
            >
              {removing ? 'Removing…' : `Yes, remove ${role.name}`}
            </button>
            <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn primary" disabled={!form.name?.trim()} onClick={save}>Save</button>
          {role.id && role.id !== 'main' && (
            <button className="btn" style={{ color: 'var(--r-fg)', marginLeft: 'auto' }} onClick={() => setConfirming(true)}>Remove from team</button>
          )}
          {role.id === 'main' && <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>The Main agent can be edited but not removed.</span>}
        </div>
      )}
    </section>
  );
}

const PRESETS: [string, string][] = [
  ['Edit files', 'Edit'],
  ['Write new files', 'Write'],
  ['Run any shell command', 'Bash'],
  ['Run tests (npm test)', 'Bash(npm test:*)'],
  ['Git commit', 'Bash(git commit:*)'],
  ['Git push', 'Bash(git push:*)'],
  ['Create GitHub repos', 'Bash(gh repo create:*)'],
];

function Team({ roles }: { roles: Role[] }) {
  const perms = useApi<{ role_id: string; tool: string; policy: 'allow' | 'deny' }[]>('/api/permissions', (m) => ['permissions', 'approvals'].includes(m?.type));
  const [editing, setEditing] = useState<Partial<Role> | null>(null);
  const [adding, setAdding] = useState(false);
  const [rule, setRule] = useState({ role: 'main', tool: 'Edit', policy: 'allow' });
  const name = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    await api('/api/permissions', { body: rule });
    perms.reload();
  };
  return (
    <>
      <div className="settings-head">
        <div><h1>Team &amp; permissions</h1><p className="muted">Each role is a Claude Code session started with its persona and skill. Shared roles see every project; project roles see only theirs.</p></div>
        <button className="btn primary" onClick={() => setAdding(true)}>+ Add member</button>
      </div>
      {adding && <AddMemberDialog onClose={() => setAdding(false)} onAdded={() => setAdding(false)} />}
      <RoleEditor role={editing} onClose={() => setEditing(null)} />
      <section className="panel scroll-x" style={{ padding: '6px 18px 10px' }}>
        <table className="table">
          <thead><tr><th>Role</th><th>Scope</th><th>Model</th><th>Skill</th><th /></tr></thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id}>
                <td><span style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span className={`avatar t-${r.tone}`}>{r.initials}</span><strong>{r.name}</strong></span></td>
                <td><span className={`pill ${r.scope === 'shared' ? 't-v' : r.scope === 'global' ? 't-b' : 't-g'}`}>{r.scope}</span></td>
                <td className="muted">{r.model}</td>
                <td className="mono" style={{ fontSize: 12 }}>{r.skill ?? '—'}</td>
                <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => setEditing(r)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="panel">
        <div className="panel-head"><h2>Standing permissions</h2><span className="muted" style={{ fontSize: 12 }}>"Always allow" in chat adds a rule here. Everything else asks.</span></div>
        {(perms.data ?? []).length === 0 && <div className="muted" style={{ fontSize: 13 }}>No standing rules yet: every action that is not reading or searching asks first.</div>}
        {(perms.data ?? []).map((p) => (
          <div key={p.role_id + p.tool} className="check-row">
            <strong style={{ width: 130, fontSize: 13 }}>{name(p.role_id)}</strong>
            <span className="mono" style={{ flex: 1, fontSize: 12 }}>{p.tool}</span>
            <span className={`pill ${p.policy === 'allow' ? 't-g' : 't-r'}`}>{p.policy === 'allow' ? 'Allowed' : 'Never'}</span>
            <button className="btn sm" onClick={async () => { await api('/api/permissions', { body: { role: p.role_id, tool: p.tool, policy: null } }); perms.reload(); }}>Revoke</button>
          </div>
        ))}
        <form onSubmit={add} className="rule-form">
          <select className="input" aria-label="Role" value={rule.role} onChange={(e) => setRule({ ...rule, role: e.target.value })}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          <select className="input" aria-label="Action" value={rule.tool} onChange={(e) => setRule({ ...rule, tool: e.target.value })}>{PRESETS.map(([l, t]) => <option key={t} value={t}>{l}</option>)}</select>
          <select className="input" aria-label="Policy" value={rule.policy} onChange={(e) => setRule({ ...rule, policy: e.target.value })}><option value="allow">Allow without asking</option><option value="deny">Never</option></select>
          <button className="btn">Add rule</button>
        </form>
      </section>
    </>
  );
}

function Usage() {
  const u = useApi<{ five_hour: { pct: number; resets_at: number } | null; seven_day: { pct: number; resets_at: number } | null; threshold: number; high: boolean }>('/api/usage', (m) => m?.type === 'usage');
  const [threshold, setThreshold] = useState<number | null>(null);
  if (!u.data) return null;
  const t = threshold ?? u.data.threshold;
  const win = (label: string, w: { pct: number; resets_at: number } | null) => (
    <div style={{ flex: '1 1 200px' }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800 }}>{w ? `${w.pct}%` : '—'}</div>
      <div className="bar" style={{ height: 6 }}><div style={{ width: `${w?.pct ?? 0}%`, background: w && w.pct >= t ? 'var(--a-fg)' : 'var(--accent)' }} /></div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{w?.resets_at ? `Resets ${new Date(w.resets_at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'No data yet: updates after an agent runs'}</div>
    </div>
  );
  return (
    <>
      <div className="settings-head"><div><h1>Usage alerts</h1><p className="muted">Your Claude subscription usage, as reported by each agent run. When it crosses the threshold you get an alert; agents keep running.</p></div></div>
      <section className="panel"><div className="row">{win('This 5-hour window', u.data.five_hour)}{win('This week', u.data.seven_day)}</div></section>
      <section className="panel" style={{ maxWidth: 640 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 8, fontWeight: 600, fontSize: 13 }}>
          Alert me when weekly usage passes <span className="mono" style={{ fontSize: 22, fontWeight: 800 }}>{t}%</span>
          <input type="range" min={10} max={99} value={t} onChange={(e) => setThreshold(Number(e.target.value))} onMouseUp={() => api('/api/usage/alert', { body: { threshold: t } }).then(u.reload)} onKeyUp={() => api('/api/usage/alert', { body: { threshold: t } }).then(u.reload)} style={{ accentColor: 'var(--accent)' }} />
        </label>
      </section>
    </>
  );
}

function Checkins() {
  const c = useApi<{ pm: number; members: number; user: number }>('/api/settings/checkins');
  const [form, setForm] = useState<{ pm: number; members: number; user: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const v = form ?? c.data;
  if (!v) return null;
  const save = async () => {
    setMsg(null);
    try {
      await api('/api/settings/checkins', { body: v });
      setMsg('Saved.');
      c.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const row = (k: 'pm' | 'members' | 'user', label: string, desc: string) => (
    <div className="switch-row">
      <span style={{ flex: 1 }}><strong style={{ fontSize: 13.5 }}>{label}</strong><br /><span className="muted" style={{ fontSize: 12 }}>{desc}</span></span>
      <label className="sr-only" htmlFor={`ck-${k}`}>{label} (hours)</label>
      <input id={`ck-${k}`} type="number" min={0.5} step={0.5} className="input mono" style={{ width: 90 }} value={v[k]} onChange={(e) => setForm({ ...v, [k]: Number(e.target.value) })} />
      <span className="muted" style={{ fontSize: 12 }}>hours</span>
    </div>
  );
  return (
    <>
      <div className="settings-head"><div><h1>Check-ins</h1><p className="muted">When a building project has had no activity (no card moves, agent messages, reviews or commits) the Main agent checks in. Any activity resets the clock. Paused and closed projects, projects in close-out, and projects waiting on you are skipped.</p></div></div>
      <section className="panel" style={{ maxWidth: 720 }}>
        {row('pm', 'Ask the PM for status', 'Green / amber / red, the blocker, and the next step.')}
        {row('members', 'Ask everyone with open cards', 'Each owner reports status and what they need.')}
        {row('user', 'Ask you', 'Pause, close, or have the Main agent dig in. Also a notification.')}
        {msg && <div className={msg === 'Saved.' ? 'muted' : 'error'} style={{ fontSize: 12.5 }}>{msg}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" onClick={save}>Save</button>
          <button className="btn" onClick={async () => { const r = await api<{ done: unknown[] }>('/api/checkins/run', { method: 'POST' }); setMsg(r.done.length ? `Checked in on ${r.done.length} project(s).` : 'Nothing needs a check-in right now.'); }}>Check now</button>
        </div>
      </section>
    </>
  );
}

function Workspace() {
  const ws = useApi<WorkspaceInfo>('/api/workspace');
  return (
    <>
      <div className="settings-head"><div><h1>Workspace</h1><p className="muted">Everything AI Brain creates lives in this folder, and agents cannot read or write outside it.</p></div></div>
      <section className="panel">
        <div className="field"><span className="muted">Folder</span><span className="mono">{ws.data?.root}</span></div>
        <div className="field"><span className="muted">Database</span><span className="mono">{ws.data?.db}</span></div>
        <div className="field"><span className="muted">Layout</span><span className="mono">vault/ · projects/ · .ai-brain/</span></div>
        <div className="muted" style={{ fontSize: 12.5 }}>To move it, run <span className="mono">brain setup &lt;new folder&gt;</span>. Existing files are not moved automatically.</div>
      </section>
    </>
  );
}

export function Settings({ section, roles }: { section: string; roles: Role[] }) {
  const cur = SECTIONS.some(([id]) => id === section) ? section : 'integrations';
  return (
    <div className="settings">
      <div className="eyebrow">Settings</div>
      <nav className="tabs" aria-label="Settings">
        {SECTIONS.map(([id, label]) => (
          <a key={id} className={`tab${cur === id ? ' on' : ''}`} aria-current={cur === id ? 'page' : undefined} href={href(`/settings/${id}`)} onClick={go(`/settings/${id}`)}>{label}</a>
        ))}
      </nav>
      <div className="settings-body">
        {cur === 'integrations' && <Integrations />}
        {cur === 'daily' && <DailySettingsPage />}
        {cur === 'team' && <Team roles={roles} />}
        {cur === 'usage' && <Usage />}
        {cur === 'checkins' && <Checkins />}
        {cur === 'workspace' && <Workspace />}
      </div>
    </div>
  );
}
