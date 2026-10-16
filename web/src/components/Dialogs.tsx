import { useEffect, useRef, useState } from 'react';
import { api, useApi } from '../lib/api';
import { navigate } from '../lib/router';
import type { Role } from '../lib/types';
import { Avatar } from './Chat';

export function Modal({ title, onClose, children, width = 560 }: { title: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector<HTMLElement>('input, textarea') ?? ref.current?.querySelector<HTMLElement>('.template, button'))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      if (e.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!ref.current.contains(document.activeElement)) (e.preventDefault(), first.focus());
      else if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={{ width: `min(${width}px, 100%)` }}>
        <div className="panel-head">
          <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>
          <button className="icon-btn" style={{ width: 32, height: 32, flex: '0 0 32px', borderRadius: 8 }} aria-label="Close" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

interface Template extends Role {
  added: boolean;
  blurb: string;
}

export function AddMemberDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (roleId: string) => void }) {
  const templates = useApi<Template[]>('/api/role-templates', (m) => m?.type === 'roles');
  const [custom, setCustom] = useState(false);
  const [form, setForm] = useState({ name: '', skill: '', scope: 'shared', model: 'sonnet', persona: '' });
  const [error, setError] = useState<string | null>(null);
  const add = async (body: unknown) => {
    setError(null);
    try {
      const r = await api<Role>('/api/roles', { body });
      onAdded(r.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const available = (templates.data ?? []).filter((t) => !t.added);
  return (
    <Modal title="Add a team member" onClose={onClose} width={620}>
      <div className="muted" style={{ fontSize: 13 }}>Each member is a Claude Code session with its own role, skill and memory. Start from a template or define your own.</div>
      {!custom && (
        <>
          <div className="template-grid">
            {available.map((t) => (
              <button key={t.id} className="template" onClick={() => add({ template: t.id })}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Avatar role={t} size={26} />
                  <strong>{t.name}</strong>
                  <span className={`pill ${t.scope === 'shared' ? 't-v' : 't-g'}`} style={{ marginLeft: 'auto' }}>{t.scope === 'shared' ? 'all projects' : 'per project'}</span>
                </div>
                <span className="muted" style={{ fontSize: 12, textAlign: 'left' }}>{t.blurb}</span>
              </button>
            ))}
            {templates.data && available.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Every template is already on your team.</div>}
          </div>
          <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setCustom(true)}>+ Custom member</button>
        </>
      )}
      {custom && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add({ ...form, skill: form.skill || null, persona: form.persona || undefined });
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <div className="form-grid">
            <label>Name<input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Legal advisor" /></label>
            <label>Skill<input className="input mono" value={form.skill} onChange={(e) => setForm({ ...form, skill: e.target.value })} placeholder="e.g. marketing:seo-audit" /></label>
            <label>Scope<select className="input" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}><option value="shared">Shared · all projects</option><option value="project">Per project</option></select></label>
            <label>Model<select className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}><option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option></select></label>
          </div>
          <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>Persona: who they are and how they work
            <textarea className="input" rows={4} style={{ color: 'var(--text)', fontSize: 13 }} value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })} placeholder="Reviews contracts and flags risky clauses in plain language…" />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={!form.name.trim()}>Add member</button>
            <button type="button" className="btn" onClick={() => setCustom(false)}>Back to templates</button>
          </div>
        </form>
      )}
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}

export function NewProjectDialog({ onClose, askMain }: { onClose: () => void; askMain: (draft: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<'software' | 'general'>('software');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api<{ id: string }>('/api/projects', { body: { name, description, type } });
      onClose();
      navigate(`/project/${p.id}/requirements`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={create} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>Name
          <input className="input" style={{ color: 'var(--text)' }} required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. habits" />
        </label>
        <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>What is it? (2–3 sentences)
          <textarea className="input" rows={4} style={{ color: 'var(--text)', fontSize: 13 }} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Who it is for, what it does, the core idea." />
        </label>
        <div className="seg" role="radiogroup" aria-label="Kind of project" style={{ alignSelf: 'flex-start' }}>
          <button type="button" aria-pressed={type === 'software'} onClick={() => setType('software')}>Software</button>
          <button type="button" aria-pressed={type === 'general'} onClick={() => setType('general')}>Anything else</button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: -4 }}>{type === 'software' ? 'Apps, websites, APIs, tools: a system design stage, and it can run on this Mac.' : 'Writing, content, research, planning, events: a brief, a plan in phases, then the work, each piece reviewed.'}</div>
        <div className="muted" style={{ fontSize: 12 }}>Creates <span className="mono">projects/{name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'name'}</span> with git and a vault folder, and starts the requirements.</div>
        {error && <div className="error">{error}</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</button>
          <span className="muted" style={{ fontSize: 12 }}>or</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              askMain(name.trim() || description.trim() ? `I have a project idea${name.trim() ? `: ${name.trim()}` : ''}. ${description.trim()}` : '');
              onClose();
            }}
          >
            Discuss it with the Main agent first
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function NewThreadDialog({
  roles,
  projects,
  defaultProject,
  onClose,
  onCreated,
  onAddMember,
}: {
  roles: Role[];
  projects: { id: string; name: string }[];
  defaultProject: string | null;
  onClose: () => void;
  onCreated: (conversationId: string) => void;
  onAddMember: () => void;
}) {
  const [topic, setTopic] = useState('');
  const [project, setProject] = useState<string>(defaultProject ?? '');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setPicked((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = await api<{ id: string }>('/api/channels', { body: { name: topic, members: [...picked], project_id: project || null, message } });
      onCreated(c.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const many = picked.size > 1;
  return (
    <Modal title="New thread" onClose={onClose} width={560}>
      <form onSubmit={create} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>Topic
          <input className="input" style={{ color: 'var(--text)' }} required value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Pricing ideas" />
        </label>
        <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>Project
          <select className="input" style={{ color: 'var(--text)' }} value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">None (general thread)</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>With</span>
          {roles.length === 0 ? (
            <div className="muted" style={{ fontSize: 12.5 }}>Your team is empty. <button type="button" className="link-btn" style={{ color: 'var(--accent)' }} onClick={onAddMember}>Add a team member</button> first.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {roles.map((r) => (
                <button type="button" key={r.id} aria-pressed={picked.has(r.id)} className={`chip${picked.has(r.id) ? ' on' : ''}`} onClick={() => toggle(r.id)}>
                  {picked.has(r.id) ? '✓ ' : '+ '}{r.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>First message (optional)
          <textarea className="input" rows={3} style={{ color: 'var(--text)', fontSize: 13 }} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={many ? 'Everyone answers in turn; @mention someone to ask just them.' : 'What do you want to discuss?'} />
        </label>
        {many && <div className="muted" style={{ fontSize: 12 }}>With several members: without an @mention each one answers in turn if they have something to add; with @mentions only those answer.</div>}
        {error && <div className="error">{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" disabled={busy || !topic.trim() || picked.size === 0}>{busy ? 'Starting…' : message.trim() ? 'Start thread and send' : 'Start thread'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
