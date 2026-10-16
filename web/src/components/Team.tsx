import { useState } from 'react';
import { api } from '../lib/api';
import type { Conversation, Role } from '../lib/types';
import { Avatar } from './Chat';
import { AddMemberDialog } from './Dialogs';

function preview(c: Conversation): string {
  if (c.working) return 'working…';
  if (!c.last) return c.kind === 'dm' ? 'No messages yet' : `${c.members.length} members`;
  return (c.last.author === 'user' ? 'You: ' : '') + c.last.body.replace(/\s+/g, ' ');
}

function NewChannel({ roles, onDone }: { roles: Role[]; onDone: (id?: string) => void }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const c = await api<{ id: string }>('/api/channels', { body: { name, members: [...picked] } });
      onDone(c.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form onSubmit={create} className="new-channel">
      <input className="input" style={{ height: 32, fontSize: 13 }} placeholder="channel-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {roles.filter((r) => r.id !== 'main').map((r) => (
          <button
            type="button"
            key={r.id}
            aria-pressed={picked.has(r.id)}
            className={`chip${picked.has(r.id) ? ' on' : ''}`}
            onClick={() => setPicked((s) => (s.has(r.id) ? (s.delete(r.id), new Set(s)) : new Set(s.add(r.id))))}
          >
            {r.name}
          </button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn sm primary" disabled={!name.trim() || !picked.size}>Create</button>
        <button type="button" className="btn sm" onClick={() => onDone()}>Cancel</button>
      </div>
    </form>
  );
}

export function TeamList({ conversations, roles, current, select }: { conversations: Conversation[]; roles: Role[]; current: string | null; select: (id: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [addingMember, setAddingMember] = useState(false);
  const byId = new Map(roles.map((r) => [r.id, r]));
  const dms = conversations.filter((c) => c.kind === 'dm' && c.role_id !== 'main');
  const channels = conversations.filter((c) => c.kind === 'channel');
  return (
    <div>
      <div className="side-label">
        <span>TEAM</span>
        <button aria-label="Add team member" title="Add team member" onClick={() => setAddingMember(true)}>+</button>
      </div>
      {addingMember && <AddMemberDialog onClose={() => setAddingMember(false)} onAdded={(id) => select(`dm:${id}`)} />}
      {dms.length === 0 && (
        <div className="muted" style={{ fontSize: 12, padding: '2px 10px 6px', lineHeight: 1.45 }}>
          Your team is empty. <button className="link-btn" style={{ color: 'var(--accent)', fontSize: 12 }} onClick={() => setAddingMember(true)}>Add a member</button>, or the Main agent will suggest one when you need it.
        </div>
      )}
      {dms.map((c) => {
        const role = byId.get(c.role_id!);
        return (
          <button key={c.id} className={`nav-row team-row${current === c.id ? ' on' : ''}`} onClick={() => select(c.id)}>
            <span style={{ position: 'relative' }}>
              <Avatar role={role} size={26} />
              <span className="presence" style={{ background: c.working ? 'var(--g-fg)' : 'var(--n-fg)' }} />
            </span>
            <span className="label" style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontWeight: c.unread ? 700 : 500 }}>{role?.name ?? c.name}</span>
              <span className="muted" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' }}>{preview(c)}</span>
            </span>
            {c.unread > 0 && <span className="badge">{c.unread}</span>}
          </button>
        );
      })}
      <div className="side-label" style={{ marginTop: 10 }}>
        <span>CHANNELS</span>
        {dms.length > 0 && <button aria-label="New channel" onClick={() => setAdding(true)}>+</button>}
      </div>
      {adding && <NewChannel roles={roles} onDone={(id) => (setAdding(false), id && select(id))} />}
      {channels.map((c) => (
        <button key={c.id} className={`nav-row${current === c.id ? ' on' : ''}`} onClick={() => select(c.id)}>
          <span style={{ width: 26, textAlign: 'center', color: 'var(--muted)', fontWeight: 600 }}>#</span>
          <span className="label" style={{ fontWeight: c.unread ? 700 : 500 }}>{c.name}</span>
          {c.working && <span className="dot" style={{ background: 'var(--g-fg)' }} />}
          {c.unread > 0 && <span className="badge">{c.unread}</span>}
        </button>
      ))}
      {!channels.length && !adding && <div className="muted" style={{ fontSize: 12, padding: '2px 10px' }}>{dms.length ? 'Group chats with several team members.' : 'Add team members to start group chats.'}</div>}
    </div>
  );
}
