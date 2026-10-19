// Settings › Skills: the craft know-how each role loads (how to write a spec,
// plan a story, review a diff...). Most are adapted from public skill repos;
// each shows where it came from, its license and what was changed. The user
// can edit their copy, compare it with the original, or reset it.
import { useState } from 'react';
import { api, useApi } from '../lib/api';
import { Modal } from '../components/Dialogs';
import type { Role } from '../lib/types';

interface Source {
  repo: string;
  path: string;
  commit: string;
  license: string;
  url: string;
}
export interface Skill {
  id: string;
  title: string;
  summary: string;
  roles: string[];
  types: string[];
  source: Source | null;
  basedOn: Source[];
  changes: string[];
  edited: boolean;
  updateAvailable: boolean;
  description: string;
}
interface Texts extends Skill {
  upstream: string | null;
  original: string;
  current: string;
}

/** A line diff (longest common subsequence): enough for files of a few hundred lines. */
function diffLines(a: string, b: string): { op: ' ' | '-' | '+'; text: string }[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { op: ' ' | '-' | '+'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) out.push({ op: ' ', text: x[i++] }), j++;
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', text: x[i++] });
    else out.push({ op: '+', text: y[j++] });
  }
  while (i < n) out.push({ op: '-', text: x[i++] });
  while (j < m) out.push({ op: '+', text: y[j++] });
  return out;
}

function Diff({ from, to }: { from: string; to: string }) {
  const lines = diffLines(from, to);
  if (!lines.some((l) => l.op !== ' ')) return <div className="muted" style={{ fontSize: 13 }}>No differences.</div>;
  return (
    <pre className="diff">
      {lines.map((l, k) => (
        <div key={k} className={l.op === '+' ? 'add' : l.op === '-' ? 'del' : undefined}>{l.op} {l.text}</div>
      ))}
    </pre>
  );
}

const repoLink = (s: Source) => <a href={s.url} target="_blank" rel="noreferrer">{s.repo}</a>;

function SkillEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useApi<Texts>(`/api/skills/${id}`);
  const [text, setText] = useState<string | null>(null);
  const [view, setView] = useState<'edit' | 'yours' | 'adaptation'>('edit');
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!s.data) return <Modal title="Skill" onClose={onClose} width={860}><div className="muted">Loading…</div></Modal>;
  const d = s.data;
  const value = text ?? d.current;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={d.title} onClose={onClose} width={860}>
      <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
        {d.source ? <>Adapted from {repoLink(d.source)} ({d.source.license}, commit <span className="mono">{d.source.commit.slice(0, 7)}</span>).</> : <>Written for Drydock.</>}
        {d.basedOn.length > 0 && <> Borrows from {d.basedOn.map((b, k) => <span key={b.repo + b.path}>{k ? ', ' : ''}{repoLink(b)} ({b.license})</span>)}.</>}
        {' '}The app keeps how each role works in Drydock separately, so editing this changes only the know-how.
      </div>
      <div className="seg" style={{ alignSelf: 'flex-start' }}>
        <button aria-pressed={view === 'edit'} onClick={() => setView('edit')}>Edit</button>
        <button aria-pressed={view === 'yours'} onClick={() => setView('yours')}>Your changes</button>
        <button aria-pressed={view === 'adaptation'} onClick={() => setView('adaptation')} disabled={!d.upstream}>What we changed</button>
      </div>
      {view === 'edit' && (
        <textarea className="input mono" rows={22} style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text)' }} value={value} onChange={(e) => setText(e.target.value)} aria-label="Skill text" spellCheck={false} />
      )}
      {view === 'yours' && <Diff from={d.original} to={value} />}
      {view === 'adaptation' && d.upstream && (
        <>
          <ul className="md-list" style={{ fontSize: 12.5, margin: 0 }}>{d.changes.map((c) => <li key={c}>{c}</li>)}</ul>
          <Diff from={d.upstream} to={d.original} />
        </>
      )}
      {error && <div className="error">{error}</div>}
      {confirmReset ? (
        <div className="confirm" role="alertdialog" aria-labelledby="reset-title">
          <strong id="reset-title">Reset {d.title} to the original?</strong>
          <span className="muted" style={{ fontSize: 12.5 }}>Your changes to this skill are discarded. Agents use the app's version from their next turn.</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn danger" autoFocus disabled={busy} onClick={() => run(() => api(`/api/skills/${id}/reset`, { method: 'POST' }))}>Yes, reset</button>
            <button className="btn" onClick={() => setConfirmReset(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn primary" disabled={busy || text === null || text === d.current} onClick={() => run(() => api(`/api/skills/${id}`, { body: { text: value } }))}>Save</button>
          <button className="btn" onClick={onClose}>Cancel</button>
          {(d.edited || text !== null) && <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setConfirmReset(true)}>Reset to original</button>}
        </div>
      )}
    </Modal>
  );
}

export function SkillsSettings({ roles }: { roles: Role[] }) {
  const skills = useApi<Skill[]>('/api/skills', (m) => m?.type === 'skills');
  const templates = useApi<{ id: string; name: string }[]>('/api/role-templates');
  const [open, setOpen] = useState<string | null>(null);
  // team members first, then templates not added yet, then the PM's subagents
  const name = (id: string) => roles.find((r) => r.id === id)?.name ?? templates.data?.find((t) => t.id === id)?.name ?? ({ builder: 'Builders', reviewer: 'Reviewers' } as Record<string, string>)[id] ?? id;
  return (
    <>
      <div className="settings-head">
        <div>
          <h1>Skills</h1>
          <p className="muted">Know-how each team member loads when the work calls for it. Most are adapted from public skill collections; you can edit any of them. How each member works inside Drydock is built in and is not affected by edits here.</p>
        </div>
      </div>
      {open && <SkillEditor id={open} onClose={() => { setOpen(null); skills.reload(); }} />}
      <section className="panel scroll-x" style={{ padding: '6px 18px 10px' }}>
        <table className="table">
          <thead><tr><th>Skill</th><th>Used by</th><th>Source</th><th /></tr></thead>
          <tbody>
            {(skills.data ?? []).map((s) => (
              <tr key={s.id}>
                <td style={{ maxWidth: 360 }}>
                  <strong>{s.title}</strong>
                  {s.edited && <span className="pill t-a" style={{ marginLeft: 8 }}>{s.updateAvailable ? 'Edited · newer original' : 'Edited'}</span>}
                  <div className="muted" style={{ fontSize: 12 }}>{s.summary}</div>
                </td>
                <td style={{ fontSize: 12.5 }}>{s.roles.map(name).join(', ')}{s.types.includes('any') ? '' : <span className="muted"> · {s.types.join(', ')} projects</span>}</td>
                <td style={{ fontSize: 12.5 }}>{s.source ? <>{repoLink(s.source)} <span className="muted">{s.source.license}</span></> : <span className="muted">Written for Drydock</span>}</td>
                <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => setOpen(s.id)}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
