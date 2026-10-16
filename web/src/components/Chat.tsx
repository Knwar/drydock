import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { onLive } from '../lib/live';
import { Markdown } from '../lib/md';
import type { Conversation, Message, Role } from '../lib/types';
import { Icon } from './Icon';

const ALWAYS = ['Read and search files', 'Search the web', 'AI Brain tools'];

export function Avatar({ role, size = 28 }: { role?: Role | null; size?: number }) {
  const tone = role?.tone ?? 'n';
  return (
    <span className={`avatar t-${tone}`} style={{ width: size, height: size, flex: `0 0 ${size}px`, borderRadius: size / 3.5, fontSize: size > 26 ? 11 : 10 }}>
      {role?.initials ?? '?'}
    </span>
  );
}

function ApprovalCard({ m, role }: { m: Message; role?: Role }) {
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'allow' | 'always' | 'deny') => {
    setBusy(true);
    try {
      await api(`/api/approvals/${m.meta.approval_id}`, { body: { decision } });
    } finally {
      setBusy(false);
    }
  };
  const status = m.meta?.status ?? 'pending';
  const detail = m.meta?.input?.command ?? m.meta?.input?.file_path ?? JSON.stringify(m.meta?.input ?? {});
  return (
    <div className="card-approval" data-status={status}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="pill t-a">{m.meta?.tool}</span>
        <span className="muted" style={{ fontSize: 12 }}>{role?.name ?? m.author} wants to</span>
      </div>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{m.body}</div>
      <div className="mono approval-cmd">{String(detail).slice(0, 400)}</div>
      {status === 'pending' ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn sm primary" disabled={busy} onClick={() => decide('allow')}>Allow once</button>
          <button className="btn sm" disabled={busy} onClick={() => decide('always')} title={`Let ${role?.name ?? 'this role'} use ${m.meta?.tool} without asking from now on`}>
            Always allow
          </button>
          <button className="btn sm" style={{ color: 'var(--r-fg)', borderColor: 'transparent' }} disabled={busy} onClick={() => decide('deny')}>
            Deny
          </button>
        </div>
      ) : (
        <span className={`pill ${status === 'allowed' ? 't-g' : 't-r'}`} style={{ alignSelf: 'flex-start' }}>
          {status === 'allowed' ? (m.meta?.always ? 'Always allowed' : 'Allowed') : 'Denied'}
        </span>
      )}
    </div>
  );
}

function DecisionCard({ m }: { m: Message }) {
  return (
    <div className="card-decision">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="check" style={{ color: 'var(--g-fg)' }} />
        <span className="eyebrow" style={{ color: 'var(--g-fg)', fontWeight: 700 }}>Decision logged</span>
      </div>
      <div style={{ fontWeight: 700, fontSize: 13 }}>{m.body}</div>
      {m.meta?.why && <div style={{ fontSize: 12.5, color: 'var(--text2)' }}>{m.meta.why}</div>}
      {m.meta?.follow_ups?.length > 0 && (
        <ul className="md-list" style={{ fontSize: 12.5 }}>
          {m.meta.follow_ups.map((f: string, i: number) => <li key={i}>{f}</li>)}
        </ul>
      )}
    </div>
  );
}

function ToolLines({ items }: { items: Message[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 1) return <div className="tool-line">{items[0].body}</div>;
  return (
    <div className="tool-line">
      <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '▾' : '▸'} {items.length} steps · {items[items.length - 1].body}
      </button>
      {open && items.map((t) => <div key={t.id} style={{ paddingLeft: 14 }}>{t.body}</div>)}
    </div>
  );
}

export function ChatPanel({ conversation, roles, onSent }: { conversation: Conversation | null; roles: Role[]; onSent?: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ role: string; text: string } | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'chat' | 'activity'>('chat');
  const logRef = useRef<HTMLDivElement>(null);
  const convId = conversation?.id ?? null;
  const byId = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);

  useEffect(() => {
    if (!convId) return;
    let alive = true;
    setMessages([]);
    setDraft(null);
    api<{ messages: Message[]; working: string | null }>(`/api/conversations/${encodeURIComponent(convId)}/messages`).then((r) => {
      if (!alive) return;
      setMessages(r.messages);
      setWorking(r.working);
    });
    api(`/api/conversations/${encodeURIComponent(convId)}/read`, { method: 'POST' }).catch(() => {});
    const off = onLive((msg) => {
      if (msg.conversation !== convId) return;
      if (msg.type === 'chat') {
        setMessages((ms) => (ms.some((m) => m.id === msg.message.id) ? ms : [...ms, msg.message]));
        if (msg.message.author !== 'user') setDraft(null);
      } else if (msg.type === 'chat_update') setMessages((ms) => ms.map((m) => (m.id === msg.message.id ? msg.message : m)));
      else if (msg.type === 'chat_delta') setDraft(msg.text ? { role: msg.role, text: msg.text } : null);
      else if (msg.type === 'chat_status') setWorking(msg.status === 'working' ? msg.role : null);
    });
    return () => {
      alive = false;
      off();
    };
  }, [convId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, draft]);

  if (!conversation) return <aside className="chat" />;

  const lead = conversation.kind === 'dm' ? byId.get(conversation.role_id!) : null;
  const memberNames = conversation.members.map((id) => byId.get(id)?.name ?? id).join(', ');
  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t) return;
    setError(null);
    setText('');
    try {
      await api(`/api/conversations/${encodeURIComponent(conversation.id)}/messages`, { body: { text: t } });
      onSent?.();
    } catch (err) {
      setError((err as Error).message);
      setText(t);
    }
  };
  const stop = () => api(`/api/conversations/${encodeURIComponent(conversation.id)}/stop`, { method: 'POST' });

  // group consecutive tool lines from the same author
  const rows: (Message | Message[])[] = [];
  for (const m of messages) {
    const prev = rows[rows.length - 1];
    if (m.kind === 'tool' && Array.isArray(prev) && prev[0].author === m.author) prev.push(m);
    else rows.push(m.kind === 'tool' ? [m] : m);
  }
  const visible = view === 'chat' ? rows : messages.filter((m) => m.kind === 'tool' || m.kind === 'approval' || m.kind === 'error').map((m) => [m] as Message[]);

  return (
    <aside className="chat" aria-label="Conversation">
      <header className="chat-head">
        {lead ? <Avatar role={lead} size={30} /> : <span className="avatar t-n" style={{ width: 30, height: 30, flex: '0 0 30px' }}>#</span>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{lead ? lead.name : `# ${conversation.name}`}</h2>
          <div className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {lead ? `${lead.scope === 'global' ? 'Personal manager · all projects' : lead.scope === 'shared' ? 'Shared role · all projects' : 'Project role'} · ${lead.model}` : `${memberNames} and you`}
          </div>
        </div>
        <div role="group" aria-label="View" className="seg">
          <button aria-pressed={view === 'chat'} onClick={() => setView('chat')}>Chat</button>
          <button aria-pressed={view === 'activity'} onClick={() => setView('activity')}>Activity</button>
        </div>
      </header>
      {lead && (
        <div className="perm-strip">
          <span className="muted">Can do on its own:</span>
          {ALWAYS.map((a) => <span key={a} className="pill t-g">{a}</span>)}
        </div>
      )}
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && !draft && (
          <div className="empty" style={{ textAlign: 'left' }}>
            {lead?.id === 'main'
              ? 'Tell me about an idea, ask about a project, or ask me to plan your day.'
              : lead
                ? `Message ${lead.name}. They keep their own memory of this conversation.`
                : 'Start the discussion. @mention a member to ask just them.'}
          </div>
        )}
        {visible.map((row) => {
          if (Array.isArray(row)) return <ToolLines key={`t${row[0].id}`} items={row} />;
          const m = row;
          if (m.author === 'user') return <div key={m.id} className="bubble-me">{m.body}</div>;
          const role = byId.get(m.author);
          if (m.kind === 'approval') return <ApprovalCard key={m.id} m={m} role={role} />;
          if (m.kind === 'decision') return <DecisionCard key={m.id} m={m} />;
          return (
            <div key={m.id} className="msg">
              <Avatar role={role} />
              <div className="msg-body">
                <div className="msg-meta">
                  <strong>{role?.name ?? m.author}</strong>
                  <span>{new Date(m.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                {m.kind === 'error' ? <div className="error">{m.body}</div> : <Markdown text={m.body} />}
              </div>
            </div>
          );
        })}
        {(draft || working) && view === 'chat' && (
          <div className="msg">
            <Avatar role={byId.get(draft?.role ?? working ?? '')} />
            <div className="msg-body">
              <div className="msg-meta">
                <strong>{byId.get(draft?.role ?? working ?? '')?.name}</strong>
                <span className="typing">working</span>
              </div>
              {draft?.text ? <Markdown text={draft.text} /> : <div className="muted" style={{ fontSize: 13 }}>Thinking…</div>}
            </div>
          </div>
        )}
      </div>
      <form className="composer" onSubmit={send}>
        <label htmlFor="chat-input" className="sr-only">Message</label>
        <textarea
          id="chat-input"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={lead?.id === 'main' ? 'Describe an idea, or ask anything…' : lead ? `Message ${lead.name}…` : `Message #${conversation.name} (@mention to ask one member)…`}
        />
        {error && <div className="error">{error}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="muted" style={{ fontSize: 11 }}>Enter to send · Shift+Enter for a new line</span>
          {working ? (
            <button type="button" className="btn sm" style={{ marginLeft: 'auto' }} onClick={stop}>Stop</button>
          ) : null}
          <button type="submit" className="btn sm primary" style={{ marginLeft: working ? 0 : 'auto' }} disabled={!text.trim()}>
            Send
          </button>
        </div>
      </form>
    </aside>
  );
}
