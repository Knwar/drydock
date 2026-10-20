// A project's Ideas tab: feature ideas for the app as it is, shaped with the
// project's PM. Each opens on its own page (Board · Changes · Screens) in
// place of the project's tabs; "Add to project" is the user's approval.
import { useState } from 'react';
import { api, useApi } from '../lib/api';
import { go, href, navigate } from '../lib/router';
import type { IdeaCard } from '../lib/types';
import { Modal } from './Dialogs';
import { ideaEvents, STATUS } from './Ideas';

function NewFeatureIdea({ projectId, projectName, onClose }: { projectId: string; projectName: string; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [pitch, setPitch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const i = await api<IdeaCard>(`/api/projects/${projectId}/ideas`, { body: { title, pitch } });
      onClose();
      navigate(`/project/${projectId}/ideas/${i.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`New feature idea for ${projectName}`} onClose={onClose}>
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="field"><span className="muted">What is it?</span><input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Batch export" /></label>
        <label className="field"><span className="muted">In one line (optional)</span><input className="input" value={pitch} onChange={(e) => setPitch(e.target.value)} placeholder="What it adds or changes, and for whom" /></label>
        <span className="muted" style={{ fontSize: 12 }}>The PM shapes it with you in its own chat. Nothing is built until you add it to the project.</span>
        {error && <div className="error">{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" disabled={!title.trim() || busy}>Start shaping</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

/** What a feature idea has so far, in small chips. */
function Progress({ i }: { i: IdeaCard }) {
  const parts = [i.requirementsVersion ? 'Changes written' : null, i.features ? `${i.features} ${i.features === 1 ? 'story' : 'stories'}` : null, i.screens ? `${i.screens} ${i.screens === 1 ? 'screen' : 'screens'}` : null].filter(Boolean);
  if (!parts.length) return <span className="muted" style={{ fontSize: 12 }}>Not shaped yet</span>;
  return (
    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {parts.map((p) => <span key={p} className="pill t-n" style={{ fontSize: 10.5 }}>{p}</span>)}
    </span>
  );
}

const GROUPS: { title: string; pick: (i: IdeaCard) => boolean }[] = [
  { title: 'Being shaped', pick: (i) => i.status === 'raw' || i.status === 'shaping' },
  { title: 'Added to the project', pick: (i) => i.status === 'added' },
  { title: 'Parked', pick: (i) => i.status === 'parked' },
];

export function FeatureIdeas({ projectId, projectName }: { projectId: string; projectName: string }) {
  const ideas = useApi<IdeaCard[]>(`/api/projects/${projectId}/ideas`, ideaEvents);
  const [adding, setAdding] = useState(false);
  const all = ideas.data ?? [];
  return (
    <>
      <section className="panel" style={{ gap: 10 }}>
        <div className="panel-head">
          <h2>Feature ideas</h2>
          <button className="btn sm primary" onClick={() => setAdding(true)}>New feature idea</button>
        </div>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.55 }}>
          New ideas for {projectName} as it is: talk them through with the PM, see the stories, the impact and any new screens take shape, and add the ones you want. The design and brand come from the project. Nothing is built until you press Add to project.
        </div>
      </section>
      {ideas.data && !all.length && <div className="empty" style={{ padding: 24 }}>No feature ideas yet. Start one here, or tell the Main agent about it: it brings ideas for this app here.</div>}
      {GROUPS.map((g) => {
        const list = all.filter(g.pick);
        if (!list.length) return null;
        return (
          <section key={g.title} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3 className="eyebrow" style={{ margin: 0 }}>{g.title} · {list.length}</h3>
            <div className="idea-grid">
              {list.map((i) => (
                <a key={i.id} className="idea-card" href={href(`/project/${projectId}/ideas/${i.id}`)} onClick={go(`/project/${projectId}/ideas/${i.id}`)}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</strong>
                    {i.working && <span className="pill t-g" style={{ fontSize: 10.5 }}>live</span>}
                    <span className={`pill ${STATUS[i.status].tone}`} style={{ fontSize: 10.5 }}>{STATUS[i.status].label}</span>
                  </div>
                  {i.pitch && <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.4 }}>{i.pitch}</div>}
                  <Progress i={i} />
                </a>
              ))}
            </div>
          </section>
        );
      })}
      {adding && <NewFeatureIdea projectId={projectId} projectName={projectName} onClose={() => setAdding(false)} />}
    </>
  );
}
