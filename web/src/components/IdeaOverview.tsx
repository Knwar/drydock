// An idea's Board: how far the thinking has come, what will be built,
// what was decided and what is still open (answered with a tap), and the
// scope map of features. The Main agent drafts every story; the user
// confirms them here, one tap each, instead of writing them.
import { useState } from 'react';
import { api } from '../lib/api';
import { Markdown } from '../lib/md';
import { Modal } from './Dialogs';

export interface Feature {
  id: string;
  module: string;
  title: string;
  priority: 'must' | 'should' | 'could' | 'wont';
  mvp: boolean;
  confirmed: boolean;
  source: string | null;
  summary: string;
  stories: string[];
  acceptance: string[];
  edge_cases: string[];
  data: string[];
  open_questions: string[];
}
export interface Section {
  kind: string;
  status: 'running' | 'done' | 'stalled';
  summary: string;
  markdown: string;
  updated_at: number;
}
export interface Analysis {
  kind: string;
  label: string;
  group: 'Understand' | 'Decide' | 'Define';
  ask: string;
}
export interface Question {
  id: string;
  text: string;
  options: string[];
  affects: string[];
  status: 'open' | 'answered';
  answer: string | null;
  kind: 'intake' | 'decision';
}
interface Data {
  id: string;
  status: string;
  requirements: { version: number; markdown: string } | null;
  sections: Section[];
  featureList: Feature[];
  questions?: Question[];
  decisions?: { id: number; title: string; why: string | null; created_at: number }[];
}

const PRIORITY: Record<Feature['priority'], { label: string; color: string }> = {
  must: { label: 'Must', color: 'var(--accent)' },
  should: { label: 'Should', color: 'var(--v-fg)' },
  could: { label: 'Could', color: 'var(--n-fg)' },
  wont: { label: "Won't", color: 'var(--border2)' },
};

/** A feature waits for the user's check once it says something (a story or a check) they have not confirmed. */
const toCheck = (f: Feature) => !f.confirmed && (f.stories.length > 0 || f.acceptance.length > 0);

/** Short names for the progress strip (the full name is in its tooltip). */
const SHORT: Record<string, string> = { problem: 'Problem', competitors: 'Competitors', market: 'Market', 'pr-faq': 'Working backwards', assumptions: 'Assumptions', risks: 'Risks', business: 'Business model', metrics: 'Metrics', features: 'Features', mvp: 'MVP cut', estimate: 'Effort', decision: 'Go / park / kill' };

/** The first lines under a requirements heading that matches (who it is for, what is out of scope). */
function under(markdown: string | undefined, heading: RegExp): string | null {
  if (!markdown) return null;
  const lines = markdown.split('\n');
  const at = lines.findIndex((l) => /^#{2,4}\s/.test(l) && heading.test(l));
  if (at < 0) return null;
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,4}\s/.test(l)) break;
    const t = l.replace(/^\s*([-*]|\d+\.)\s+/, '').replace(/\*\*/g, '').trim();
    if (t && !/^_to discuss\._$/i.test(t)) body.push(t);
    if (body.join(' ').length > 220) break;
  }
  const text = body.join(' · ');
  return text ? (text.length > 240 ? `${text.slice(0, 239)}…` : text) : null;
}

/** "How far the thinking has come": the analyses in order; done ones open, the rest can be run. */
function Progress({ d, analyses, run, readOnly }: { d: Data; analyses: Analysis[]; run: (kind: string) => void; readOnly: boolean }) {
  const [open, setOpen] = useState<Analysis | null>(null);
  const state = (k: string) => d.sections.find((x) => x.kind === k);
  const done = analyses.filter((a) => state(a.kind)?.status === 'done').length;
  const next = analyses.find((a) => !state(a.kind));
  const sec = open ? state(open.kind) : undefined;
  return (
    <section className="panel" style={{ gap: 10 }}>
      <div className="panel-head">
        <h2 style={{ fontSize: 15 }}>How far the thinking has come</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          {done} of {analyses.length}
          {next && !readOnly && <> · next suggested: <button className="link-btn" style={{ color: 'var(--accent)', fontSize: 12 }} onClick={() => setOpen(next)}>{next.label}</button></>}
        </span>
      </div>
      <div className="progress-steps">
        {analyses.map((a) => {
          const s = state(a.kind)?.status;
          return (
            <button key={a.kind} className={`progress-step${s ? ` s-${s}` : ''}`} onClick={() => setOpen(a)} title={s === 'done' ? `${a.label}: read it` : s === 'running' ? `${a.label}: working on it` : `${a.label}: not run yet`}>
              <span className="progress-bar" />
              <span>{SHORT[a.kind] ?? a.label}</span>
            </button>
          );
        })}
      </div>
      {open && (
        <Modal title={open.label} onClose={() => setOpen(null)} width={sec?.markdown ? 820 : 520}>
          {sec?.markdown ? (
            <>
              {sec.summary && <div className="muted" style={{ fontSize: 12.5 }}>{sec.summary}</div>}
              <Markdown text={sec.markdown} />
            </>
          ) : sec?.status === 'running' ? (
            <div className="muted" style={{ fontSize: 13 }}>The Main agent is working on it; it shows here when it is done.</div>
          ) : (
            <div style={{ fontSize: 13, lineHeight: 1.55 }}>{sec?.status === 'stalled' ? 'The last run ended without saving a result.' : 'Not run yet.'} <span className="muted">{open.ask}</span></div>
          )}
          {!readOnly && sec?.status !== 'running' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn primary" onClick={() => (run(open.kind), setOpen(null))}>{sec?.markdown ? 'Run it again' : 'Run it'}</button>
              <button className="btn" onClick={() => setOpen(null)}>Close</button>
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}

/** What will be built: features per module, first release against later. */
function Built({ d }: { d: Data }) {
  const live = d.featureList.filter((f) => f.priority !== 'wont');
  const modules = [...new Set(live.map((f) => f.module))];
  const rows = modules.map((m) => ({ m, mvp: live.filter((f) => f.module === m && f.mvp).length, later: live.filter((f) => f.module === m && !f.mvp).length }));
  const max = Math.max(1, ...rows.map((r) => r.mvp + r.later));
  const mvp = live.filter((f) => f.mvp).length;
  const forWho = under(d.requirements?.markdown, /user|who|audience|for whom|persona/i);
  const notIn = under(d.requirements?.markdown, /out of scope|not in|won.?t|non-goal/i);
  return (
    <section className="panel" style={{ flex: '999 1 420px', minWidth: 0 }}>
      <div className="panel-head">
        <h2>What will be built</h2>
        {live.length > 0 && <span className="muted" style={{ fontSize: 12 }}>{live.length} feature{live.length === 1 ? '' : 's'} in {modules.length} module{modules.length === 1 ? '' : 's'}{mvp ? ` · ${mvp} in the first release` : ''}</span>}
      </div>
      {!live.length ? (
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>Nothing broken down yet. Press <strong>Feature breakdown</strong> in the chat, or just describe what it should do: the Main agent splits it into modules and features and drafts their stories for you to check.</div>
      ) : (
        <>
          <div className="built-legend">
            <span><i style={{ background: 'var(--accent)' }} />First release</span>
            <span><i style={{ background: 'var(--done)', opacity: 0.45 }} />Later</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {rows.map((r) => (
              <div key={r.m} className="built-row">
                <span className="built-name">{r.m}</span>
                <span className="built-bar">
                  {r.mvp > 0 && <span style={{ width: `${(r.mvp / max) * 100}%`, background: 'var(--accent)' }} />}
                  {r.later > 0 && <span style={{ width: `${(r.later / max) * 100}%`, background: 'var(--done)', opacity: 0.45 }} />}
                </span>
                <span className="mono muted" style={{ fontSize: 12, textAlign: 'right' }}>{r.mvp} + {r.later}</span>
              </div>
            ))}
          </div>
          {(forWho || notIn) && (
            <div className="built-notes">
              {forWho && <div><span className="eyebrow">For</span><span>{forWho}</span></div>}
              {notIn && <div><span className="eyebrow">Not in this version</span><span>{notIn}</span></div>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Decided({ d }: { d: Data }) {
  const [all, setAll] = useState(false);
  const list = d.decisions ?? [];
  const shown = all ? list : list.slice(0, 4);
  return (
    <section className="panel" style={{ gap: 10 }}>
      <h2>Decided so far</h2>
      {!list.length ? (
        <div className="muted" style={{ fontSize: 13 }}>Nothing decided yet. Choices you agree on in the chat are logged here.</div>
      ) : (
        shown.map((x) => (
          <div key={x.id} className="decided-row">
            <span className="mono muted" style={{ fontSize: 11 }}>{new Date(x.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{x.title}</span>
              {x.why && <span className="muted" style={{ fontSize: 12, lineHeight: 1.4 }}>{x.why}</span>}
            </div>
          </div>
        ))
      )}
      {list.length > 4 && <button className="link-btn" style={{ alignSelf: 'flex-start', color: 'var(--accent)', fontSize: 12 }} onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${list.length}`}</button>}
    </section>
  );
}

/** Still open: the lead's questions with likely answers; a tap (or a few words) answers. */
function StillOpen({ d, readOnly }: { d: Data; readOnly: boolean }) {
  const [other, setOther] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = (d.questions ?? []).filter((q) => q.status === 'open');
  // the basics come first: answering the last one (or skipping) starts the first pass
  const basics = open.filter((q) => q.kind === 'intake');
  const skip = async () => {
    setBusy('skip');
    setError(null);
    try {
      await api(`/api/ideas/${d.id}/intake/skip`, { method: 'POST' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const answered = (d.questions ?? []).filter((q) => q.status === 'answered').slice(-2);
  // older ideas keep their open questions as notes on features
  const notes = d.featureList.flatMap((f) => f.open_questions.map((q) => ({ f: f.id, q }))).slice(0, 4);
  const answer = async (id: string, value: string) => {
    if (!value.trim()) return;
    setBusy(id);
    setError(null);
    try {
      await api(`/api/ideas/${d.id}/questions/${id}/answer`, { body: { answer: value } });
      setOther(null);
      setText('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (!open.length && !answered.length && !notes.length) return null;
  return (
    <section className="panel still-open" style={{ gap: 12 }}>
      <div className="panel-head">
        <h2>{basics.length ? 'A few basics first' : 'Still open'}</h2>
        {open.length > 0 && <span style={{ fontSize: 12 }}>{open.length} to answer{readOnly ? '' : ' · tap one'}</span>}
      </div>
      {basics.length > 0 && <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>Answer these and the Main agent lays the idea out: the problem, users, core flow, features and the decisions that matter.</div>}
      {[...basics, ...open.filter((q) => q.kind !== 'intake')].map((q) => (
        <div key={q.id} style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <span style={{ fontSize: 13, lineHeight: 1.45 }}>{q.text}{q.affects.length > 0 && <span className="affects"> · {q.affects.join(', ')}</span>}</span>
          {!readOnly && (
            <div className="answer-chips">
              {q.options.map((o) => <button key={o} disabled={busy === q.id} onClick={() => answer(q.id, o)}>{o}</button>)}
              <button className="other" disabled={busy === q.id} onClick={() => (setOther(other === q.id ? null : q.id), setText(''))} aria-expanded={other === q.id}>Something else…</button>
            </div>
          )}
          {other === q.id && (
            <form style={{ display: 'flex', gap: 6 }} onSubmit={(e) => (e.preventDefault(), void answer(q.id, text))}>
              <input className="input" autoFocus aria-label={`Your answer to: ${q.text}`} placeholder="In a few words" value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1, height: 34 }} />
              <button className="btn sm primary" disabled={!text.trim() || busy === q.id}>Answer</button>
            </form>
          )}
        </div>
      ))}
      {basics.length > 0 && !readOnly && (
        <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={busy === 'skip'} onClick={skip}>Skip, use your best guesses</button>
      )}
      {answered.map((q) => (
        <div key={q.id} style={{ fontSize: 12.5, display: 'flex', gap: 6 }}>
          <span style={{ color: 'var(--g-fg)' }}>✓</span>
          <span><span className="muted">{q.text}</span> {q.answer}</span>
        </div>
      ))}
      {notes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="eyebrow">Notes on features</span>
          {notes.map((n) => <span key={n.f + n.q} style={{ fontSize: 12.5, lineHeight: 1.45 }}><span className="mono muted">{n.f}</span> {n.q}</span>)}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}

type Verdict = { id: string; verdict: 'ok' | 'change' | 'drop'; reason?: string };
const REASONS = ['Wrong user', 'Too much for the first release', 'A case is missing', 'The check is wrong'];

/** Send review verdicts: confirmations apply now; changes and drops go to the Main agent in one message. */
async function sendReview(ideaId: string, items: Verdict[]) {
  return api<{ confirmed: number; changed: number; dropped: number }>(`/api/ideas/${ideaId}/features/review`, { body: { items } });
}

/** The spec of one feature, with the review buttons while it is a draft. */
function Spec({ d, f, readOnly }: { d: Data; f: Feature; readOnly: boolean }) {
  const [mode, setMode] = useState<'idle' | 'change' | 'drop'>('idle');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (v: Verdict) => {
    setBusy(true);
    setError(null);
    try {
      await sendReview(d.id, [v]);
      setMode('idle');
      setReason('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const list = (h: string, items: string[]) => (items.length ? <div className="spec-block"><span className="eyebrow">{h}</span><ul className="md-list" style={{ margin: 0 }}>{items.map((x) => <li key={x}>{x}</li>)}</ul></div> : null);
  return (
    <aside className="scope-spec" aria-label={`${f.id} ${f.title}`}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="mono muted" style={{ fontSize: 11 }}>{f.id} · {f.module}</span>
        <span className="pill" style={{ fontSize: 10.5, background: 'var(--n-bg)', color: PRIORITY[f.priority].color }}>{PRIORITY[f.priority].label}</span>
        <span className={`pill ${f.confirmed ? 't-g' : 't-n'}`} style={{ fontSize: 10.5 }}>{f.confirmed ? 'Confirmed' : toCheck(f) ? 'Draft · check it' : 'Not detailed yet'}</span>
      </div>
      <h3 style={{ margin: 0, fontSize: 16, lineHeight: 1.3 }}>{f.title}</h3>
      {f.summary && <div style={{ fontSize: 13, lineHeight: 1.5 }}>{f.summary}</div>}
      {list('User stories', f.stories)}
      {list('Acceptance checks', f.acceptance)}
      {list('Edge cases', f.edge_cases)}
      {list('Data', f.data)}
      {list('Open questions', f.open_questions)}
      {!f.stories.length && !f.acceptance.length && <div className="muted" style={{ fontSize: 12.5 }}>No stories yet: ask for the feature breakdown in the chat.</div>}
      {f.source && <span className="muted" style={{ fontSize: 11.5 }}>Drafted from {f.source}</span>}
      {error && <div className="error">{error}</div>}
      {!readOnly && toCheck(f) && mode === 'idle' && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn sm looks-right" disabled={busy} onClick={() => send({ id: f.id, verdict: 'ok' })}>Looks right</button>
          <button className="btn sm" disabled={busy} onClick={() => setMode('change')}>Change…</button>
          <button className="btn sm" style={{ color: 'var(--r-fg)' }} disabled={busy} onClick={() => setMode('drop')}>Not this</button>
        </div>
      )}
      {mode === 'change' && (
        <div className="review-change">
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>What's off? Tap one, or say it in a few words.</span>
          <div className="answer-chips">{REASONS.map((r) => <button key={r} disabled={busy} onClick={() => send({ id: f.id, verdict: 'change', reason: r })}>{r}</button>)}</div>
          <form style={{ display: 'flex', gap: 6 }} onSubmit={(e) => (e.preventDefault(), reason.trim() && void send({ id: f.id, verdict: 'change', reason }))}>
            <input className="input" autoFocus aria-label="What to change" placeholder="e.g. it's for both parents" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1, height: 34 }} />
            <button className="btn sm primary" disabled={busy || !reason.trim()}>Send</button>
            <button type="button" className="btn sm" onClick={() => setMode('idle')}>Cancel</button>
          </form>
        </div>
      )}
      {mode === 'drop' && (
        <div className="review-change">
          <span style={{ fontSize: 12.5 }}>Remove <strong>{f.id} {f.title}</strong>? The Main agent takes it out and updates the requirements.</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn sm danger" disabled={busy} onClick={() => send({ id: f.id, verdict: 'drop' })}>Yes, remove it</button>
            <button className="btn sm" onClick={() => setMode('idle')}>Cancel</button>
          </div>
        </div>
      )}
    </aside>
  );
}

/** Go through the drafted features one at a time; changes and drops are sent together at the end. */
function Review({ d, drafts, onClose }: { d: Data; drafts: Feature[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [done, setDone] = useState<Verdict[]>([]);
  const [changing, setChanging] = useState(false);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<{ confirmed: number; changed: number; dropped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const f = drafts[i];
  const finish = async (all: Verdict[]) => {
    if (!all.length) return onClose();
    setBusy(true);
    setError(null);
    try {
      setResult(await sendReview(d.id, all));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const next = (v: Verdict) => {
    const all = [...done, v];
    setDone(all);
    setChanging(false);
    setReason('');
    if (i + 1 >= drafts.length) void finish(all);
    else setI(i + 1);
  };
  const color = { ok: 'var(--g-fg)', change: 'var(--accent)', drop: 'var(--r-fg)' };
  return (
    <Modal title={result ? 'Review done' : `Check the drafted stories · ${Math.min(i + 1, drafts.length)} of ${drafts.length}`} onClose={() => (result || !done.length ? onClose() : void finish(done))} width={720}>
      <div className="review-dots">{drafts.map((x, k) => <span key={x.id} style={{ background: k < done.length ? color[done[k].verdict] : k === i && !result ? 'var(--text)' : 'var(--border)' }} />)}</div>
      {result ? (
        <>
          <div style={{ fontSize: 14, lineHeight: 1.55 }}>
            {result.confirmed} confirmed, {result.changed} to change, {result.dropped} removed.
            {result.changed + result.dropped > 0 && ' The Main agent is working on the changes; rewritten stories come back here as drafts.'}
          </div>
          <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={onClose}>Back to the board</button>
        </>
      ) : f ? (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="mono muted" style={{ fontSize: 11.5 }}>{f.id} · {f.module}</span>
            {f.mvp && <span className="pill t-b" style={{ fontSize: 10.5 }}>First release</span>}
          </div>
          <h3 style={{ margin: 0, fontSize: 19 }}>{f.title}</h3>
          {f.stories.length > 0 && <div className="spec-block"><span className="eyebrow">User story</span>{f.stories.map((s) => <span key={s} style={{ fontSize: 14, lineHeight: 1.55 }}>{s}</span>)}</div>}
          {f.acceptance.length > 0 && <div className="spec-block"><span className="eyebrow">How we'll know it works</span>{f.acceptance.map((s) => <span key={s} style={{ fontSize: 13, lineHeight: 1.5 }}><span style={{ color: 'var(--g-fg)' }}>✓</span> {s}</span>)}</div>}
          {!f.stories.length && !f.acceptance.length && <div className="muted" style={{ fontSize: 13 }}>{f.summary || 'No stories yet.'}</div>}
          {f.source && <span className="muted" style={{ fontSize: 12 }}>Drafted from {f.source}</span>}
          {changing && (
            <div className="review-change">
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>What's off? Tap one, or say it in a few words.</span>
              <div className="answer-chips">{REASONS.map((r) => <button key={r} onClick={() => next({ id: f.id, verdict: 'change', reason: r })}>{r}</button>)}</div>
              <form style={{ display: 'flex', gap: 6 }} onSubmit={(e) => (e.preventDefault(), reason.trim() && next({ id: f.id, verdict: 'change', reason }))}>
                <input className="input" autoFocus aria-label="What to change" placeholder="In a few words" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1, height: 36 }} />
                <button className="btn sm primary" disabled={!reason.trim()}>Next</button>
              </form>
            </div>
          )}
          {error && <div className="error">{error}</div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn primary looks-right" disabled={busy} autoFocus onClick={() => next({ id: f.id, verdict: 'ok' })}>Looks right</button>
            <button className="btn" disabled={busy} onClick={() => setChanging(true)}>Change…</button>
            <button className="btn" style={{ color: 'var(--r-fg)' }} disabled={busy} onClick={() => next({ id: f.id, verdict: 'drop' })}>Not this</button>
            {done.length > 0 && <button className="btn sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => finish(done)}>Stop here and save</button>}
          </div>
          <span className="muted" style={{ fontSize: 11.5 }}>Not this removes it once you finish. Changes and removals go to the Main agent together.</span>
        </>
      ) : null}
    </Modal>
  );
}

/** The scope map: modules left to right; above the line ships first. */
function ScopeMap({ d, readOnly }: { d: Data; readOnly: boolean }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [showWont, setShowWont] = useState(false);
  if (!d.featureList.length) return null;
  const modules = [...new Set(d.featureList.map((f) => f.module))];
  const live = d.featureList.filter((f) => f.priority !== 'wont');
  const wont = d.featureList.filter((f) => f.priority === 'wont');
  const drafts = [...live.filter((f) => f.mvp && toCheck(f)), ...live.filter((f) => !f.mvp && toCheck(f))];
  const sel = d.featureList.find((f) => f.id === picked) ?? drafts[0] ?? live[0];
  const card = (f: Feature) => (
    <button key={f.id} className={`scope-card${f.mvp ? '' : ' later'}${toCheck(f) ? ' draft' : ''}${sel?.id === f.id ? ' on' : ''}`} onClick={() => setPicked(f.id)} aria-pressed={sel?.id === f.id}>
      <span className="scope-card-top">
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><i style={{ background: PRIORITY[f.priority].color }} /><span className="mono muted">{f.id}</span></span>
        <span className={f.confirmed ? 'ok' : 'muted'}>{f.confirmed ? '✓' : toCheck(f) ? 'Draft' : ''}</span>
      </span>
      <span className="scope-card-title">{f.title}</span>
      {f.mvp && (
        <span className="scope-card-meta">
          <span>{f.stories.length} stor{f.stories.length === 1 ? 'y' : 'ies'}</span>
          <span>{f.acceptance.length} check{f.acceptance.length === 1 ? '' : 's'}</span>
          {f.open_questions.length > 0 && <span style={{ color: 'var(--a-fg)' }}>{f.open_questions.length} open</span>}
        </span>
      )}
    </button>
  );
  const row = (mvp: boolean) => modules.map((m) => <div key={m} className="scope-col">{live.filter((f) => f.module === m && f.mvp === mvp).map(card)}</div>);
  const hasLater = live.some((f) => !f.mvp);
  const hasMvp = live.some((f) => f.mvp);
  return (
    <section className="panel" style={{ gap: 12 }}>
      <div className="panel-head" style={{ flexWrap: 'wrap', rowGap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 'auto' }}>
          <h2>Scope map</h2>
          <span className="muted" style={{ fontSize: 12 }}>Modules in the order a user meets them. Above the line ships first.</span>
        </div>
        <div className="built-legend">
          {(['must', 'should', 'could'] as const).map((p) => <span key={p}><i style={{ background: PRIORITY[p].color }} />{PRIORITY[p].label}</span>)}
          <span><i style={{ border: '1px dashed var(--muted)', background: 'none' }} />Draft</span>
        </div>
        {!readOnly && drafts.length > 0 && <button className="btn sm primary" onClick={() => setReviewing(true)}>Check {drafts.length} drafted stor{drafts.length === 1 ? 'y' : 'ies'}</button>}
      </div>
      <div className="scope-wrap">
        <div className="scope-map" style={{ gridTemplateColumns: `repeat(${modules.length}, minmax(150px, 1fr))` }}>
          {modules.map((m) => <div key={m} className="scope-module">{m}</div>)}
          {hasMvp && <div className="scope-line" style={{ gridColumn: `1 / span ${modules.length}` }}><span>First release</span></div>}
          {hasMvp && row(true)}
          {hasLater && <div className="scope-line later" style={{ gridColumn: `1 / span ${modules.length}` }}><span>{hasMvp ? 'Later' : 'Not cut yet: ask for the MVP cut'}</span></div>}
          {hasLater && row(false)}
        </div>
        {sel && <Spec key={sel.id} d={d} f={sel} readOnly={readOnly} />}
      </div>
      {wont.length > 0 && (
        <div>
          <button className="link-btn muted" style={{ fontSize: 12 }} aria-expanded={showWont} onClick={() => setShowWont((v) => !v)}>{showWont ? '▾' : '▸'} {wont.length} deliberately not built</button>
          {showWont && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>{wont.map((f) => <button key={f.id} className="pill t-n" style={{ border: 0, cursor: 'pointer' }} onClick={() => setPicked(f.id)}>{f.id} {f.title}</button>)}</div>}
        </div>
      )}
      {reviewing && <Review d={d} drafts={drafts} onClose={() => setReviewing(false)} />}
    </section>
  );
}

/** A new idea while the Main agent works it through: the basics you gave, and the step it is on. */
function Thinking({ d }: { d: Data }) {
  const qs = d.questions ?? [];
  const basics = qs.filter((q) => q.kind === 'intake' && q.status === 'answered');
  const steps: [string, boolean][] = [
    ['Reading your idea', qs.length > 0 || d.sections.length > 0],
    ['Restating the problem and who it is for', d.sections.some((x) => x.kind === 'problem' && x.status === 'done')],
    ['Fanning out the features', d.featureList.length > 0],
    ['Writing the requirements', (d.requirements?.version ?? 0) > 1],
    ['Finding what you need to decide', qs.some((q) => q.kind === 'decision')],
  ];
  const at = steps.findIndex(([, done]) => !done);
  return (
    <section className="panel think" style={{ gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="spin" aria-hidden />
        <h2 style={{ margin: 0 }}>Thinking it through</h2>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>The Main agent is turning your idea into the problem, features and requirements. This board fills in as it goes.</div>
      {basics.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="eyebrow" style={{ fontWeight: 700 }}>What you told us</div>
          {basics.map((q) => (
            <div key={q.id} style={{ fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span className="muted">{q.text}</span>
              <strong>{q.answer}</strong>
            </div>
          ))}
        </div>
      )}
      <ol className="think-steps">
        {steps.map(([label, done], i) => (
          <li key={label} className={done ? 'done' : i === at ? 'now' : ''}>
            <span className="think-dot" aria-hidden>{done ? '✓' : i === at ? <span className="spin sm" /> : ''}</span>
            {label}{i === at && <span className="typing" />}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function IdeaOverview({ d, analyses, run, working = false }: { d: Data; analyses: Analysis[]; run: (kind: string) => void; working?: boolean }) {
  const readOnly = d.status === 'promoted';
  // while the basics are being asked they are the one thing to do, so they lead the page
  const intake = (d.questions ?? []).some((q) => q.kind === 'intake' && q.status === 'open');
  // until the first features land, the agent's progress leads the page; after that a slim line says it is working
  const first = working && !intake && d.featureList.length === 0;
  return (
    <>
      {intake && <StillOpen d={d} readOnly={readOnly} />}
      {first && <Thinking d={d} />}
      {working && !intake && !first && (
        <div className="think-bar"><span className="spin sm" aria-hidden /> The Main agent is updating this board<span className="typing" /></div>
      )}
      <Progress d={d} analyses={analyses} run={run} readOnly={readOnly} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
        <Built d={d} />
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Decided d={d} />
          {!intake && <StillOpen d={d} readOnly={readOnly} />}
        </div>
      </div>
      <ScopeMap d={d} readOnly={readOnly} />
    </>
  );
}

