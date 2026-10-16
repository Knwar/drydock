import { useState } from 'react';
import type { Conversation, Role } from '../lib/types';
import { Avatar } from './Chat';
import { AddMemberDialog } from './Dialogs';

function preview(c: Conversation): string {
  if (c.working) return 'working…';
  if (!c.last) return c.kind === 'dm' ? 'No messages yet' : `${c.members.length} members`;
  return (c.last.author === 'user' ? 'You: ' : '') + c.last.body.replace(/\s+/g, ' ');
}

export function TeamList({ conversations, roles, current, select, onNewThread }: { conversations: Conversation[]; roles: Role[]; current: string | null; select: (id: string) => void; onNewThread: () => void }) {
  const [addingMember, setAddingMember] = useState(false);
  const byId = new Map(roles.map((r) => [r.id, r]));
  const dms = conversations.filter((c) => c.kind === 'dm' && c.role_id !== 'main');
  // project threads live under their project in the tree; only general threads here
  const channels = conversations.filter((c) => c.kind === 'channel' && !c.project_id);
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
        <span>THREADS</span>
        <button aria-label="New thread" title="New thread" onClick={onNewThread}>+</button>
      </div>
      {channels.map((c) => (
        <button key={c.id} className={`nav-row${current === c.id ? ' on' : ''}`} onClick={() => select(c.id)}>
          <span style={{ width: 26, textAlign: 'center', color: 'var(--muted)', fontWeight: 600 }}>#</span>
          <span className="label" style={{ fontWeight: c.unread ? 700 : 500 }}>{c.name}</span>
          {c.working && <span className="dot" style={{ background: 'var(--g-fg)' }} />}
          {c.unread > 0 && <span className="badge">{c.unread}</span>}
        </button>
      ))}
      {!channels.length && <div className="muted" style={{ fontSize: 12, padding: '2px 10px', lineHeight: 1.45 }}>{dms.length ? 'General threads with one or more members. Project threads live under each project’s Discussions.' : 'Add team members to start threads.'}</div>}
    </div>
  );
}
