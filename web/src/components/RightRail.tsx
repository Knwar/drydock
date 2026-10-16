// Shown in place of the chat panel when it is minimised: what needs you,
// who is working, today, usage and quick capture.
import { useState } from 'react';
import { api, useApi } from '../lib/api';
import { go, href } from '../lib/router';
import type { Conversation, Role } from '../lib/types';
import type { PersonalData } from '../pages/Personal';
import { Avatar } from './Chat';
import { Icon } from './Icon';

interface NeedsYou {
  approvals: { id: string; role: string; tool: string; summary: string; conversation: string | null }[];
  proposals: { message_id: number; conversation: string; title: string; reason: string | null }[];
}

export function RightRail({ roles, conversations, open, onExpand, onHide }: { roles: Role[]; conversations: Conversation[]; open: (conversationId: string) => void; onExpand: () => void; onHide?: () => void }) {
  const needs = useApi<NeedsYou>('/api/needs-you', (m) => ['approvals', 'chat', 'chat_update'].includes(m?.type));
  const personal = useApi<PersonalData>('/api/personal', (m) => ['personal', 'daily'].includes(m?.type));
  const usage = useApi<{ five_hour: { pct: number } | null; seven_day: { pct: number } | null; high: boolean; threshold: number }>('/api/usage', (m) => m?.type === 'usage');
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState(false);
  const byId = new Map(roles.map((r) => [r.id, r]));
  const working = conversations.filter((c) => c.working);
  const unread = conversations.filter((c) => c.unread > 0);
  const n = needs.data;
  const waiting = (n?.approvals.length ?? 0) + (n?.proposals.length ?? 0);
  const today = personal.data;
  const agenda = today
    ? [
        ...today.week.events.filter((e) => e.day === today.today).map((e) => ({ k: e.id, t: e.time ?? 'All day', title: e.title })),
        ...today.reminders.filter((r) => !r.done && r.due && r.due.slice(0, 10) <= today.today).map((r) => ({ k: `r${r.id}`, t: 'Due', title: r.text })),
      ].sort((a, b) => a.t.localeCompare(b.t))
    : [];
  const save = async () => {
    if (!note.trim()) return;
    await api('/api/notes', { body: { text: note } });
    setNote('');
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  const label = (id: string | null) => {
    if (id === 'dm:main') return 'Main agent';
    const c = conversations.find((x) => x.id === id);
    if (c?.kind === 'channel') return `#${c.name}`;
    return byId.get(id?.replace(/^dm:/, '') ?? '')?.name ?? id ?? '';
  };
  return (
    <aside className="rail" aria-label="Overview">
      <div className="rail-head">
        <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>At a glance</span>
        <button className="btn sm" onClick={onExpand} title="Open the chat">
          <Icon name="chat" size={14} /> Chat
        </button>
        {onHide && <button className="icon-btn" style={{ width: 28, height: 28, borderRadius: 8, fontSize: 13 }} aria-label="Hide panel" title="Hide panel" onClick={onHide}>✕</button>}
      </div>

      <section className="rail-card">
        <div className="rail-title">Needs you {waiting > 0 && <span className="badge" style={{ background: 'var(--r-fg)' }}>{waiting}</span>}</div>
        {waiting === 0 && <div className="muted" style={{ fontSize: 12.5 }}>Nothing waiting on you.</div>}
        {n?.approvals.map((a) => (
          <button key={a.id} className="rail-row" onClick={() => a.conversation && open(a.conversation)}>
            <span className="pill t-a">{a.tool}</span>
            <span className="label">{byId.get(a.role)?.name ?? a.role}: {a.summary}</span>
          </button>
        ))}
        {n?.proposals.map((p) => (
          <button key={p.message_id} className="rail-row" onClick={() => open(p.conversation)}>
            <span className="pill t-b">Team</span>
            <span className="label">{p.title}</span>
          </button>
        ))}
      </section>

      <section className="rail-card">
        <div className="rail-title">Working now</div>
        {working.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>No agent is running.</div>}
        {working.map((c) => (
          <button key={c.id} className="rail-row" onClick={() => open(c.id)}>
            <Avatar role={byId.get(c.working!)} size={22} />
            <span className="label">{byId.get(c.working!)?.name} <span className="muted">in {label(c.id)}</span></span>
            <span className="dot" style={{ background: 'var(--g-fg)' }} />
          </button>
        ))}
        {unread.length > 0 && <div className="rail-sub">Unread</div>}
        {unread.map((c) => (
          <button key={c.id} className="rail-row" onClick={() => open(c.id)}>
            <span className="label">{label(c.id)}</span>
            <span className="badge">{c.unread}</span>
          </button>
        ))}
      </section>

      <section className="rail-card">
        <div className="rail-title" style={{ justifyContent: 'space-between' }}>Today <a className="link-btn" style={{ fontSize: 12 }} href={href('/personal')} onClick={go('/personal')}>Week →</a></div>
        {today?.edition && <div style={{ fontSize: 12.5, fontWeight: 600 }}>{today.edition.headline}</div>}
        {agenda.length === 0 ? (
          <div className="muted" style={{ fontSize: 12.5 }}>Nothing scheduled.</div>
        ) : (
          agenda.slice(0, 6).map((a) => (
            <div key={a.k} style={{ display: 'flex', gap: 8, fontSize: 12.5 }}>
              <span className="mono muted" style={{ width: 52, flex: '0 0 52px' }}>{a.t}</span>
              <span>{a.title}</span>
            </div>
          ))
        )}
      </section>

      <section className="rail-card">
        <div className="rail-title">Usage</div>
        {(['five_hour', 'seven_day'] as const).map((k) => {
          const w = usage.data?.[k];
          return (
            <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span className="muted">{k === 'five_hour' ? 'This 5-hour window' : 'This week'}</span><span className="mono">{w ? `${w.pct}%` : '—'}</span></div>
              <div className="bar"><div style={{ width: `${w?.pct ?? 0}%`, background: w && usage.data && w.pct >= usage.data.threshold ? 'var(--a-fg)' : 'var(--accent)' }} /></div>
            </div>
          );
        })}
      </section>

      <section className="rail-card">
        <div className="rail-title">Quick capture</div>
        <label className="sr-only" htmlFor="rail-note">Capture a note</label>
        <textarea id="rail-note" className="input" rows={3} style={{ fontSize: 13 }} placeholder="A thought, an idea… (⌘↵ to save)" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && save()} />
        <button className="btn sm" style={{ alignSelf: 'flex-end' }} disabled={!note.trim()} onClick={save}>{saved ? 'Saved ✓' : 'Save to notes'}</button>
      </section>
    </aside>
  );
}
