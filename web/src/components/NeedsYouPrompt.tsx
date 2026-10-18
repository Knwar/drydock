// What an agent is waiting on you for, as a popup wherever you are in the
// app: a permission to run something, or a key to add. Oldest first; Later
// hides one until the next reload (it stays in its chat).
import { useState } from 'react';
import { api, useApi } from '../lib/api';
import type { Conversation, Message, Role } from '../lib/types';
import { AddSecretDialog } from '../pages/SecretsSettings';
import { Avatar } from './Chat';
import { Modal } from './Dialogs';

interface Approval {
  id: string;
  role_id: string;
  conversation_id: string | null;
  tool: string;
  input: any;
  created_at: number;
}
interface SecretAsk {
  message_id: number;
  conversation: string;
  name: string;
}

const where = (c?: Conversation) => (!c ? '' : c.kind === 'dm' ? 'your direct chat' : `#${c.name}`);

export function NeedsYouPrompt({ roles, conversations, openChat }: { roles: Role[]; conversations: Conversation[]; openChat: (conversationId: string) => void }) {
  const approvals = useApi<Approval[]>('/api/approvals', (m) => m?.type === 'approvals');
  const needs = useApi<{ secrets: SecretAsk[] }>('/api/needs-you', (m) => ['approvals', 'chat', 'chat_update', 'secrets'].includes(m?.type));
  const [later, setLater] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<Message | null>(null);
  const role = (id: string) => roles.find((r) => r.id === id);
  const conv = (id: string | null) => conversations.find((c) => c.id === id);

  const queue = [
    ...(approvals.data ?? []).map((a) => ({ key: `a${a.id}`, at: a.created_at, a })),
    ...(needs.data?.secrets ?? []).map((s) => ({ key: `s${s.message_id}`, at: 0, s })),
  ].filter((x) => !later.has(x.key));
  const item = queue[0];
  if (adding) return <AddSecretDialog projects={[]} preset={{ name: adding.meta.name, project_id: adding.meta.project_id ?? null, request: adding.id, purpose: adding.meta.purpose, url: adding.meta.url }} onClose={() => setAdding(null)} onSaved={() => (setAdding(null), needs.reload())} />;
  if (!item) return null;

  const skip = () => (setError(null), setLater((s) => new Set(s).add(item.key)));
  const open = (id: string | null) => {
    if (id) openChat(id);
    skip();
  };
  const decide = async (id: string, decision: 'allow' | 'always' | 'deny') => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/approvals/${id}`, { body: { decision } });
      approvals.reload();
    } catch (e) {
      setError((e as Error).message);
      approvals.reload();
    } finally {
      setBusy(false);
    }
  };
  const addKey = async (s: SecretAsk) => {
    // the request card holds the details the add dialog needs (purpose, link, project)
    try {
      const { messages } = await api<{ messages: Message[] }>(`/api/conversations/${encodeURIComponent(s.conversation)}/messages`);
      const m = messages.find((x) => x.id === s.message_id);
      if (m) setAdding(m);
      else setError('That request is gone.');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const count = queue.length > 1 ? ` · 1 of ${queue.length}` : '';

  if ('a' in item && item.a) {
    const a = item.a;
    const r = role(a.role_id);
    const c = conv(a.conversation_id);
    const detail = a.input?.command ?? a.input?.file_path ?? a.input?.url ?? JSON.stringify(a.input ?? {});
    return (
      <Modal title={`${r?.name ?? a.role_id} needs your OK${count}`} onClose={skip} width={520}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Avatar role={r} size={30} />
          <div style={{ fontSize: 13 }}>
            Wants to use <span className="pill t-a">{a.tool}</span>{c ? <> in <strong>{where(c)}</strong></> : null}
          </div>
        </div>
        <div className="mono approval-cmd" style={{ maxHeight: 180, overflow: 'auto' }}>{String(detail).slice(0, 1200)}</div>
        {error && <div className="error">{error}</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn primary" autoFocus disabled={busy} onClick={() => decide(a.id, 'allow')}>Allow once</button>
          <button className="btn" disabled={busy} onClick={() => decide(a.id, 'always')} title={`Let ${r?.name ?? 'this member'} use ${a.tool} without asking from now on`}>Always allow</button>
          <button className="btn" style={{ color: 'var(--r-fg)' }} disabled={busy} onClick={() => decide(a.id, 'deny')}>Deny</button>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {a.conversation_id && <button className="btn sm" onClick={() => open(a.conversation_id)}>Open chat</button>}
            <button className="btn sm" onClick={skip}>Later</button>
          </span>
        </div>
        <div className="muted" style={{ fontSize: 11.5 }}>The agent is paused until you answer. Later keeps it waiting; the request stays in its chat.</div>
      </Modal>
    );
  }
  const s = (item as { s: SecretAsk }).s;
  const c = conv(s.conversation);
  return (
    <Modal title={`A key is needed${count}`} onClose={skip} width={480}>
      <div style={{ fontSize: 13 }}>
        {c ? <><strong>{where(c)}</strong> needs </> : 'An agent needs '}<span className="mono">{s.name}</span>. It goes straight to your password manager; agents never see it.
      </div>
      {error && <div className="error">{error}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn primary" autoFocus onClick={() => addKey(s)}>Add it now</button>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="btn sm" onClick={() => open(s.conversation)}>Open chat</button>
          <button className="btn sm" onClick={skip}>Later</button>
        </span>
      </div>
    </Modal>
  );
}
