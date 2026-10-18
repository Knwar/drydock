import { localDay } from '../lib/time';
import { useState } from 'react';
import { api, useApi } from '../lib/api';
import { Markdown } from '../lib/md';
import { go, href } from '../lib/router';

export interface Edition {
  day: string;
  number: number;
  headline: string;
  summary: string | null;
  focus: string | null;
  sections: { title: string; items: { text: string; tone?: string }[] }[];
  audio: string | null;
  created_at: number;
}

export interface PersonalData {
  today: string;
  week: { from: string; to: string; events: { id: string; day: string; time: string | null; title: string; meta: string | null; category: string }[] };
  reminders: { id: number; text: string; due: string | null; done: number }[];
  inbox: { id: string; sender: string; subject: string; summary: string | null; tag: string; action: string | null; received: string | null }[];
  bills: { id: string; name: string; amount: number | null; currency: string | null; due: string | null; autopay: number }[];
  spending: { month: string; rows: { category: string; amount: number; currency: string | null }[] };
  notes: { file: string; title: string; body: string; modified: number }[];
  edition: Edition | null;
  generating: boolean;
}

const CAT_TONE: Record<string, string> = { work: 'b', personal: 'g', social: 'v', reminder: 'a', money: 'a', alert: 'r' };
const TAG_TONE: Record<string, string> = { reply: 'r', payment: 'a', project: 'v', personal: 'g', travel: 'b', action: 'n' };
export const personalEvents = (m: any) => ['personal', 'daily'].includes(m?.type);

const money = (n: number | null, c?: string | null) => (n === null ? '—' : `${c && c !== 'USD' ? c + ' ' : '$'}${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
const dayLabel = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

export function DailyCard({ edition, generating, compact = false }: { edition: Edition | null; generating: boolean; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    setBusy(true);
    try {
      await api('/api/daily/generate', { method: 'POST' });
    } finally {
      setBusy(false);
    }
  };
  if (!edition && compact)
    return (
      <article className="panel compact-empty">
        <span className="eyebrow">The Daily</span>
        <span className="muted" style={{ flex: 1 }}>No edition yet.</span>
        <button className="btn sm" disabled={busy || generating} onClick={generate}>{generating ? 'Writing…' : 'Write today’s'}</button>
      </article>
    );
  if (!edition)
    return (
      <article className="panel daily">
        <div className="eyebrow">The Daily</div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>No edition yet</div>
        <div className="muted" style={{ fontSize: 13 }}>The main agent writes it each morning at the time set in Settings. You can also ask for one now.</div>
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy || generating} onClick={generate}>{generating ? 'Writing…' : 'Write today’s edition'}</button>
      </article>
    );
  return (
    <article className="panel daily" aria-labelledby="daily-h">
      <div className="daily-mast">
        <div>
          <div className="eyebrow">The Daily · edition {edition.number}</div>
          <h2 id="daily-h" className="daily-title">{dayLabel(edition.day)}</h2>
          {edition.day !== localDay() && <span className="pill t-a" style={{ alignSelf: 'flex-start' }} title="Generate a new edition for today">Not today’s edition</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {edition.audio && <audio controls src={`/api/daily/${edition.day}/audio`} style={{ height: 32 }} />}
          {compact ? (
            <a className="btn sm" href={href('/personal')} onClick={go('/personal')}>Open</a>
          ) : (
            <button className="btn sm" disabled={busy || generating} onClick={generate}>{generating ? 'Writing…' : 'Rewrite'}</button>
          )}
        </div>
      </div>
      <div className="daily-body">
        <div className="daily-lead">
          <div className="daily-headline">{edition.headline}</div>
          {edition.summary && <p style={{ margin: 0, color: 'var(--text2)', lineHeight: 1.6 }}>{edition.summary}</p>}
          {edition.focus && <span className="pill t-b" style={{ alignSelf: 'flex-start', fontSize: 12, whiteSpace: 'normal' }}>Focus: {edition.focus}</span>}
        </div>
        {!compact &&
          edition.sections.map((s) => (
            <div key={s.title} className="daily-col">
              <div className="eyebrow" style={{ fontWeight: 700 }}>{s.title}</div>
              {s.items.map((i, k) => (
                <div key={k} style={{ display: 'flex', gap: 8, fontSize: 13, lineHeight: 1.45 }}>
                  <span className="dot" style={{ marginTop: 6, background: `var(--${CAT_TONE[i.tone ?? 'work'] ?? 'n'}-fg)` }} />
                  <span><Markdown text={i.text} /></span>
                </div>
              ))}
            </div>
          ))}
      </div>
    </article>
  );
}

function Week({ data }: { data: PersonalData }) {
  const days: string[] = [];
  for (let d = new Date(data.week.from + 'T12:00:00'); days.length < 7; d.setDate(d.getDate() + 1)) days.push(d.toISOString().slice(0, 10));
  const due = data.reminders.filter((r) => !r.done && r.due);
  return (
    <section className="panel" style={{ flex: '2 1 560px', minWidth: 0 }}>
      <div className="panel-head">
        <h2>This week</h2>
        <div className="legend">
          {[['b', 'Work'], ['g', 'Personal'], ['v', 'Social'], ['a', 'Bills & reminders']].map(([t, l]) => (
            <span key={l}><i style={{ background: `var(--${t}-fg)` }} />{l}</span>
          ))}
        </div>
      </div>
      <div className="scroll-x">
        <div className="week">
          {days.map((d) => {
            const items = [
              ...data.week.events.filter((e) => e.day === d).map((e) => ({ key: e.id, time: e.time ?? 'All day', title: e.title, tone: CAT_TONE[e.category] ?? 'b' })),
              ...due.filter((r) => r.due!.slice(0, 10) === d).map((r) => ({ key: `r${r.id}`, time: r.due!.slice(11, 16) || 'Reminder', title: r.text, tone: 'a' })),
            ];
            const isToday = d === data.today;
            return (
              <div key={d} className={`week-day${isToday ? ' today' : ''}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="eyebrow">{new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' })}</span>
                  <span className={isToday ? 'today-num' : ''} style={{ fontWeight: 700, fontSize: 13 }}>{Number(d.slice(8))}</span>
                </div>
                {items.map((i) => (
                  <div key={i.key} className="week-ev" style={{ background: `var(--${i.tone}-bg)`, boxShadow: `inset 3px 0 0 var(--${i.tone}-fg)` }}>
                    <span className="mono muted" style={{ fontSize: 10 }}>{i.time}</span>
                    <span>{i.title}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {data.week.events.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No calendar events recorded. They appear after the Daily runs with Google Calendar connected.</div>}
    </section>
  );
}

function Reminders({ data }: { data: PersonalData }) {
  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    await api('/api/reminders', { body: { text, due: due || null } });
    setText('');
    setDue('');
  };
  const open = data.reminders.filter((r) => !r.done).length;
  return (
    <section className="panel" style={{ flex: '1 1 280px', minWidth: 0 }}>
      <div className="panel-head"><h2>Reminders</h2><span className="muted" style={{ fontSize: 12 }}>{open} open</span></div>
      {data.reminders.map((r) => (
        <div key={r.id} className="check-row">
          <button role="checkbox" aria-checked={Boolean(r.done)} aria-label={r.text} className={`check${r.done ? ' on' : ''}`} onClick={() => api(`/api/reminders/${r.id}`, { body: { done: !r.done } })}>
            {r.done ? '✓' : ''}
          </button>
          <span style={{ flex: 1, fontSize: 13, textDecoration: r.done ? 'line-through' : undefined, color: r.done ? 'var(--muted)' : undefined }}>{r.text}</span>
          {r.due && !r.done && <span className={`pill ${r.due.slice(0, 10) <= data.today ? 't-a' : 't-n'}`}>{r.due.slice(0, 10) === data.today ? 'today' : r.due.slice(5, 10)}</span>}
          <button className="link-btn" aria-label={`Delete ${r.text}`} onClick={() => api(`/api/reminders/${r.id}`, { method: 'DELETE' })}>×</button>
        </div>
      ))}
      <form onSubmit={add} style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <label className="sr-only" htmlFor="rem">New reminder</label>
        <input id="rem" className="input" style={{ flex: 1, height: 34, fontSize: 13 }} placeholder="+ Add a reminder" value={text} onChange={(e) => setText(e.target.value)} />
        <label className="sr-only" htmlFor="rem-due">Due date</label>
        <input id="rem-due" type="date" className="input" style={{ height: 34, fontSize: 12, width: 132 }} value={due} onChange={(e) => setDue(e.target.value)} />
      </form>
    </section>
  );
}

function Mail({ items, title, empty }: { items: PersonalData['inbox']; title: string; empty: string }) {
  return (
    <section className="panel" style={{ flex: '1 1 320px', minWidth: 0 }}>
      <h2>{title}</h2>
      {items.length === 0 && <div className="muted" style={{ fontSize: 13 }}>{empty}</div>}
      {items.map((e) => (
        <div key={e.id} className="mail-row">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong style={{ fontSize: 13 }}>{e.sender}</strong><span className={`pill t-${TAG_TONE[e.tag] ?? 'n'}`}>{e.tag}</span></div>
          <div style={{ fontSize: 12.5, color: 'var(--text2)' }}>{e.subject}</div>
          {e.summary && <div className="muted" style={{ fontSize: 12 }}>{e.summary}</div>}
          <div style={{ display: 'flex', gap: 6 }}>
            {e.action && <span className="pill t-n" style={{ fontSize: 11 }}>{e.action}</span>}
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => api(`/api/inbox/${encodeURIComponent(e.id)}`, { body: { status: 'done' } })}>Done</button>
            <button className="btn sm" style={{ borderColor: 'transparent' }} onClick={() => api(`/api/inbox/${encodeURIComponent(e.id)}`, { body: { status: 'dismissed' } })}>Dismiss</button>
          </div>
        </div>
      ))}
    </section>
  );
}

function Notes({ data }: { data: PersonalData }) {
  const [text, setText] = useState('');
  const save = async () => {
    if (!text.trim()) return;
    await api('/api/notes', { body: { text } });
    setText('');
  };
  return (
    <section className="panel" style={{ flex: '1 1 280px', minWidth: 0 }}>
      <h2>Notes</h2>
      <label className="sr-only" htmlFor="note">Capture a note</label>
      <textarea id="note" className="input" rows={2} placeholder="Capture a thought… saved to vault/personal/notes" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && save()} />
      <button className="btn sm" style={{ alignSelf: 'flex-end' }} disabled={!text.trim()} onClick={save}>Save note</button>
      {data.notes.map((n) => (
        <div key={n.file} className="note">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong style={{ fontSize: 13 }}>{n.title}</strong><span className="muted" style={{ fontSize: 10.5 }}>{new Date(n.modified).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span></div>
          {n.body && <div style={{ fontSize: 12.5, color: 'var(--text2)' }}>{n.body.slice(0, 160)}</div>}
        </div>
      ))}
    </section>
  );
}

function Finances({ data }: { data: PersonalData }) {
  const rows = data.spending.rows;
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const max = Math.max(1, ...rows.map((r) => r.amount));
  const monthName = new Date(data.spending.month + '-15').toLocaleDateString('en-GB', { month: 'long' });
  return (
    <section className="panel" style={{ flex: '2 1 480px', minWidth: 0 }}>
      <div className="panel-head"><h2>Finances · {monthName}</h2><span className="muted" style={{ fontSize: 12 }}>From bank and receipt emails</span></div>
      {rows.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>No spending recorded this month. The main agent fills this from receipts and bank emails when Gmail is connected.</div>
      ) : (
        <div className="row" style={{ gap: 24 }}>
          <div style={{ flex: '1 1 180px' }}>
            <div className="muted" style={{ fontSize: 12 }}>Spent so far</div>
            <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em' }}>{money(total, rows[0]?.currency)}</div>
            <div className="muted" style={{ fontSize: 12 }}>{rows.length} categories</div>
          </div>
          <div style={{ flex: '1.4 1 260px', display: 'flex', flexDirection: 'column', gap: 8 }} role="list" aria-label="Spending by category">
            {rows.map((r) => (
              <div key={r.category} role="listitem" title={`${r.category}: ${money(r.amount, r.currency)}`} style={{ display: 'grid', gridTemplateColumns: '110px minmax(0,1fr) 70px', gap: 10, alignItems: 'center', fontSize: 12.5 }}>
                <span>{r.category}</span>
                <div style={{ height: 10 }}><div style={{ width: `${Math.max(2, (r.amount / max) * 100)}%`, height: 10, background: 'var(--accent)', borderRadius: '0 4px 4px 0' }} /></div>
                <span className="mono" style={{ textAlign: 'right' }}>{money(r.amount, r.currency)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Bills({ data }: { data: PersonalData }) {
  const total = data.bills.reduce((s, b) => s + (b.amount ?? 0), 0);
  return (
    <section className="panel" style={{ flex: '1 1 320px', minWidth: 0 }}>
      <div className="panel-head"><h2>Bills</h2>{data.bills.length > 0 && <span className="mono" style={{ fontWeight: 700 }}>{money(total)}</span>}</div>
      {data.bills.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No bills found yet.</div>}
      {data.bills.map((b) => (
        <div key={b.id} className="check-row">
          <div className={`date-chip t-${b.due && b.due <= data.today ? 'a' : 'n'}`}>
            <span style={{ fontSize: 9.5, fontWeight: 700 }}>{b.due ? new Date(b.due + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short' }).toUpperCase() : '—'}</span>
            <span style={{ fontSize: 14, fontWeight: 800 }}>{b.due ? Number(b.due.slice(8)) : ''}</span>
          </div>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{b.name}</span>
          <span className="mono" style={{ fontSize: 13 }}>{money(b.amount, b.currency)}</span>
          {b.autopay ? <span className="pill t-g">Autopay</span> : <button className="btn sm" onClick={() => api(`/api/bills/${encodeURIComponent(b.id)}`, { body: { status: 'paid' } })}>Mark paid</button>}
        </div>
      ))}
    </section>
  );
}

export function Personal() {
  const p = useApi<PersonalData>('/api/personal', personalEvents);
  if (p.error) return <div className="error">{p.error}</div>;
  if (!p.data) return null;
  const d = p.data;
  const personalThreads = d.inbox.filter((i) => i.tag === 'personal');
  const actionMail = d.inbox.filter((i) => i.tag !== 'personal');
  return (
    <>
      <DailyCard edition={d.edition} generating={d.generating} />
      <div className="row">
        <Week data={d} />
        <Reminders data={d} />
      </div>
      <div className="row">
        <Mail items={actionMail} title="Mail · needs action" empty="Nothing needs action, or Gmail is not connected yet." />
        <Mail items={personalThreads} title="Personal threads" empty="Messages from friends and family appear here (from email for now)." />
        <Notes data={d} />
      </div>
      <div className="row">
        <Finances data={d} />
        <Bills data={d} />
      </div>
    </>
  );
}
