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
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api<{ id: string }>('/api/projects', { body: { name, description } });
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
