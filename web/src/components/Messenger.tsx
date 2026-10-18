// The messenger: every conversation in one panel that slides in from the
// right (header toggle). A list first; picking one opens it in the panel with
// a way back to the list. "New chat" starts a direct chat with a team member,
// a group thread, or adds a member. Idea chats open on their idea's page.
import { useEffect, useMemo, useState } from 'react';
import { navigate } from '../lib/router';
import { threadName } from './Shell';
import type { Conversation, ProjectSummary, Role } from '../lib/types';
import { Avatar, ChatPanel } from './Chat';
import { AddMemberDialog, Modal, NewThreadDialog } from './Dialogs';
import { Icon } from './Icon';

/** Conversations the messenger lists (background work is not a chat). */
export const listed = (cs: Conversation[]) => cs.filter((c) => !c.id.startsWith('sys:'));

function preview(c: Conversation): string {
  if (c.working) return 'working…';
  if (!c.last) return c.kind === 'dm' ? 'No messages yet' : `${c.members.length} member${c.members.length === 1 ? '' : 's'}`;
  return (c.last.author === 'user' ? 'You: ' : '') + c.last.body.replace(/\s+/g, ' ');
}

function Row({ c, title, sub, role, onOpen }: { c: Conversation; title: string; sub?: string; role?: Role; onOpen: () => void }) {
  return (
    <button className="msg-row" onClick={onOpen}>
      <span style={{ position: 'relative' }}>
        {role ? <Avatar role={role} size={32} /> : <span className="avatar t-n" style={{ width: 32, height: 32, flex: '0 0 32px' }}>{c.idea_id ? <Icon name="idea" size={15} /> : '#'}</span>}
        {c.working && <span className="presence" style={{ background: 'var(--g-fg)' }} />}
      </span>
      <span className="msg-row-text">
        <span style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <span style={{ fontWeight: c.unread ? 700 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
          {sub && <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{sub}</span>}
        </span>
        <span className="muted msg-preview">{preview(c)}</span>
      </span>
      {c.unread > 0 && <span className="badge">{c.unread}</span>}
    </button>
  );
}

export function Messenger({ conversations, roles, projects, onSent, onClose }: { conversations: Conversation[]; roles: Role[]; projects: ProjectSummary[]; onSent: () => void; onClose: () => void }) {
  const [current, setCurrent] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [starting, setStarting] = useState(false);
  const [newThread, setNewThread] = useState(false);
  const [adding, setAdding] = useState(false);
  const byRole = new Map(roles.map((r) => [r.id, r]));
  const all = listed(conversations);
  const open = all.find((c) => c.id === current) ?? null;
  // Esc steps back: the chat to the list, the list closes. A dialog on top handles its own Esc:
  // listening in the capture phase sees it before the dialog's own handler closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.modal-back')) return;
      if (current) setCurrent(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [current, onClose]);

  const sections = useMemo(() => {
    const match = (c: Conversation, label: string) => !q.trim() || `${label} ${c.name}`.toLowerCase().includes(q.trim().toLowerCase());
    const label = (c: Conversation) => (c.kind === 'dm' ? byRole.get(c.role_id ?? '')?.name ?? c.name : c.name);
    const main = all.filter((c) => c.id === 'dm:main');
    const team = all.filter((c) => c.kind === 'dm' && c.id !== 'dm:main');
    const threads = all.filter((c) => c.kind === 'channel' && !c.project_id && !c.idea_id);
    const ideas = all.filter((c) => c.idea_id);
    const byProject = projects.map((p) => ({ p, list: all.filter((c) => c.kind === 'channel' && c.project_id === p.id) })).filter((x) => x.list.length);
    return {
      main: main.filter((c) => match(c, 'Main agent')),
      team: team.filter((c) => match(c, label(c))),
      threads: threads.filter((c) => match(c, c.name)),
      projects: byProject.map((x) => ({ ...x, list: x.list.filter((c) => match(c, `${x.p.name} ${c.name}`)) })).filter((x) => x.list.length),
      ideas: ideas.filter((c) => match(c, c.name)),
      label,
    };
  }, [all, projects, q, roles]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (c: Conversation) => (c.idea_id ? navigate(`/idea/${c.idea_id}`) : setCurrent(c.id));
  const empty = !sections.main.length && !sections.team.length && !sections.threads.length && !sections.projects.length && !sections.ideas.length;

  return (
    <aside className="messenger" aria-label="Messages">
      {open ? (
        <ChatPanel key={open.id} conversation={open} roles={roles} projects={projects} onSent={onSent} onClose={onClose} onBack={() => setCurrent(null)} />
      ) : (
        <>
          <div className="msg-head">
            <h2>Messages</h2>
            <button className="btn sm primary" onClick={() => setStarting(true)}><Icon name="plus" size={14} /> New chat</button>
            <button className="msg-close" aria-label="Close messages" title="Close (Esc)" onClick={onClose}><Icon name="close" size={16} /></button>
          </div>
          <div style={{ padding: '0 12px 8px', display: 'flex' }}>
            <input style={{ flex: 1 }} className="input" placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" />
          </div>
          <div className="msg-list">
            {sections.main.map((c) => <Row key={c.id} c={c} title="Main agent" role={byRole.get('main')} onOpen={() => go(c)} />)}
            {sections.team.length > 0 && <div className="msg-label">Team</div>}
            {sections.team.map((c) => <Row key={c.id} c={c} title={sections.label(c)} role={byRole.get(c.role_id ?? '')} onOpen={() => go(c)} />)}
            {sections.threads.length > 0 && <div className="msg-label">Threads</div>}
            {sections.threads.map((c) => <Row key={c.id} c={c} title={`# ${c.name}`} onOpen={() => go(c)} />)}
            {sections.projects.map(({ p, list }) => (
              <div key={p.id}>
                <div className="msg-label">{p.name}</div>
                {list.map((c) => <Row key={c.id} c={c} title={`# ${threadName(c, p.root.split('/').pop())}`} onOpen={() => go(c)} />)}
              </div>
            ))}
            {sections.ideas.length > 0 && <div className="msg-label">Ideas</div>}
            {sections.ideas.map((c) => <Row key={c.id} c={c} title={c.name} sub="opens the idea" onOpen={() => go(c)} />)}
            {empty && <div className="muted" style={{ padding: 16, fontSize: 13 }}>{q ? 'Nothing matches.' : 'No conversations yet. Start one with New chat.'}</div>}
          </div>
        </>
      )}
      {starting && (
        <Modal title="Start a chat" onClose={() => setStarting(false)} width={460}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => (setStarting(false), setNewThread(true))}># New group thread</button>
            <button className="btn sm" onClick={() => (setStarting(false), setAdding(true))}><Icon name="plus" size={14} /> Add a team member</button>
          </div>
          <div className="msg-label" style={{ padding: '4px 0 0' }}>Message someone</div>
          <div className="msg-pick">
            {all.filter((c) => c.kind === 'dm').map((c) => (
              <button key={c.id} className="msg-row" onClick={() => (setStarting(false), setCurrent(c.id))}>
                <Avatar role={byRole.get(c.role_id ?? '')} size={28} />
                <span className="msg-row-text">
                  <span style={{ fontWeight: 600 }}>{c.id === 'dm:main' ? 'Main agent' : sections.label(c)}</span>
                  <span className="muted msg-preview">{byRole.get(c.role_id ?? '')?.skill ?? (c.id === 'dm:main' ? 'Your personal manager' : '')}</span>
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {newThread && (
        <NewThreadDialog roles={roles} projects={projects.map((p) => ({ id: p.id, name: p.name }))} defaultProject={null} onClose={() => setNewThread(false)} onCreated={(id) => (setNewThread(false), onSent(), setCurrent(id))} onAddMember={() => (setNewThread(false), setAdding(true))} />
      )}
      {adding && <AddMemberDialog onClose={() => setAdding(false)} onAdded={(id) => (setAdding(false), onSent(), setCurrent(`dm:${id}`))} />}
    </aside>
  );
}
