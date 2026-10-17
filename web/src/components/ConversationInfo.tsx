// A conversation's details, opened from the chat header: who is in it, how
// big each member's session has grown (context and turns, against the point
// where it starts fresh by itself), what the chat has used, and a way to
// restart one member's session.
import { useState } from 'react';
import { api, useApi } from '../lib/api';
import { when } from '../lib/time';
import type { Role } from '../lib/types';
import { Avatar } from './Chat';
import { Modal } from './Dialogs';

interface Member {
  id: string;
  name: string;
  model: string | null;
  effort: string | null;
  lead: boolean;
  working: boolean;
  session: { active: boolean; turns: number; context_tokens: number } | null;
  usage: { runs: number; input: number; cache_read: number; cache_write: number; output: number; cost: number | null; last_at: number } | null;
}
interface Info {
  id: string;
  kind: 'dm' | 'channel';
  name: string;
  created_at: number;
  messages: number;
  limits: { maxTurns: number; maxContextTokens: number };
  members: Member[];
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }} className="muted">
        <span>{label}</span>
        <span className="mono">{pct}%</span>
      </div>
      <div className="bar" style={{ height: 5 }} role="meter" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${pct}%`, background: pct >= 85 ? 'var(--a-fg)' : 'var(--accent)' }} />
      </div>
    </div>
  );
}

export function ConversationInfo({ id, title, roles, onClose }: { id: string; title: string; roles: Role[]; onClose: () => void }) {
  const info = useApi<Info>(`/api/conversations/${encodeURIComponent(id)}/info`, (m) => ['chat', 'chat_status', 'conversations'].includes(m?.type) && (!m.conversation || m.conversation === id));
  const [confirm, setConfirm] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = info.data;
  const total = d?.members.reduce((a, m) => ({ runs: a.runs + (m.usage?.runs ?? 0), cost: a.cost + (m.usage?.cost ?? 0), output: a.output + (m.usage?.output ?? 0) }), { runs: 0, cost: 0, output: 0 });
  const restart = async (m: Member) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/conversations/${encodeURIComponent(id)}/sessions/${m.id}/reset`, { method: 'POST' });
      setConfirm(null);
      info.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} width={640}>
      {!d ? (
        <div className="muted">Loading…</div>
      ) : (
        <>
          <div className="muted" style={{ fontSize: 12.5, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <span>{d.kind === 'dm' ? 'Direct chat' : `Thread · ${d.members.length} member${d.members.length === 1 ? '' : 's'} and you`}</span>
            <span>Started {when(d.created_at)}</span>
            <span>{d.messages} messages</span>
            {total && total.runs > 0 && <span>{total.runs} agent runs · {k(total.output)} tokens written{total.cost ? ` · about $${total.cost.toFixed(2)} at API prices` : ''}</span>}
          </div>
          {error && <div className="error">{error}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {d.members.map((m) => {
              const role = roles.find((r) => r.id === m.id);
              const s = m.session;
              return (
                <section key={m.id} className="panel" style={{ gap: 10, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Avatar role={role} size={30} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        {m.name}
                        {m.lead && <span className="pill t-b" style={{ fontSize: 10.5 }}>lead</span>}
                        <span className={`pill ${m.working ? 't-g' : 't-n'}`} style={{ fontSize: 10.5 }}>{m.working ? 'working' : 'idle'}</span>
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>{[m.model, m.effort && `${m.effort} effort`].filter(Boolean).join(' · ')}</div>
                    </div>
                    <button className="btn sm" disabled={!s?.active || m.working || busy} title={!s?.active ? 'No session to restart yet' : m.working ? 'Working now: wait or stop them first' : 'Start a fresh session'} onClick={() => setConfirm(m)}>Restart session</button>
                  </div>
                  {s?.active && !s.turns && !s.context_tokens ? (
                    <div className="muted" style={{ fontSize: 12 }}>Session size not measured yet: it shows after their next reply.</div>
                  ) : s?.active ? (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <Meter value={s.context_tokens} max={d.limits.maxContextTokens} label={`Context ${k(s.context_tokens)} of ${k(d.limits.maxContextTokens)}`} />
                      <Meter value={s.turns} max={d.limits.maxTurns} label={`Turns ${s.turns} of ${d.limits.maxTurns}`} />
                    </div>
                  ) : (
                    <div className="muted" style={{ fontSize: 12 }}>{s ? 'Restarted: the next reply starts a fresh session.' : 'Has not replied here yet.'}</div>
                  )}
                  {m.usage && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      In this chat: {m.usage.runs} run{m.usage.runs === 1 ? '' : 's'} · read {k(m.usage.cache_read + m.usage.input)} (mostly from cache) · wrote {k(m.usage.output)}
                      {m.usage.cost ? ` · about $${m.usage.cost.toFixed(2)}` : ''} · last {when(m.usage.last_at)}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
            A session starts fresh by itself, with a handover summary, at {k(d.limits.maxContextTokens)} of context or {d.limits.maxTurns} turns (Settings › Usage alerts). Restart one sooner if a member seems confused or stuck on old details.
          </div>
        </>
      )}
      {confirm && (
        <div className="confirm" role="alertdialog" aria-labelledby="restart-title">
          <strong id="restart-title">Restart {confirm.name}'s session?</strong>
          <span className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            Their next reply here starts a fresh session. They get the last 20 messages of this chat as a recap, but forget older details and what their tools returned. Nothing they already did is undone, and their other chats are not affected.
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" autoFocus disabled={busy} onClick={() => restart(confirm)}>{busy ? 'Restarting…' : 'Restart session'}</button>
            <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
