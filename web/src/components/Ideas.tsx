// The Idea board on Home, and the quick capture dialog. Ideas are cheap: a
// title and a line. Shaping happens in each idea's chat; promotion makes a
// project of it.
import { useState } from 'react';
import { api, useApi } from '../lib/api';
import { go, href, navigate } from '../lib/router';
import type { IdeaCard } from '../lib/types';
import { Modal } from './Dialogs';

export const ideaEvents = (m: any) => ['idea', 'requirements', 'design', 'conversations', 'chat_status'].includes(m?.type);

export const STATUS: Record<IdeaCard['status'], { label: string; tone: string }> = {
  raw: { label: 'New', tone: 't-n' },
  shaping: { label: 'Shaping', tone: 't-v' },
  parked: { label: 'Parked', tone: 't-a' },
  promoted: { label: 'Project', tone: 't-g' },
};

/** What has been shaped so far, in a line of small chips. */
export function Shaped({ i }: { i: IdeaCard }) {
  const parts = [
    i.requirementsVersion ? `Requirements v${i.requirementsVersion}` : null,
    i.type === 'software' && i.designElements ? `Design · ${i.designElements}` : null,
    i.brand ? `Brand · ${i.brand.name}` : null,
    i.screens ? `UI · ${i.screens} screen${i.screens === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  if (!parts.length) return <span className="muted" style={{ fontSize: 12 }}>Not shaped yet</span>;
  return (
    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {parts.map((p) => <span key={p} className="pill t-n" style={{ fontSize: 10.5 }}>{p}</span>)}
    </span>
  );
}

export function CaptureIdeaDialog({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [pitch, setPitch] = useState('');
  const [type, setType] = useState<'software' | 'general'>('software');
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const i = await api<IdeaCard>('/api/ideas', { body: { title, pitch, type } });
      onClose();
      navigate(`/idea/${i.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title="New idea" onClose={onClose}>
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="field"><span className="muted">Title</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Habit tracker for busy parents" /></label>
        <label className="field"><span className="muted">In one line (optional)</span><input className="input" value={pitch} onChange={(e) => setPitch(e.target.value)} placeholder="What it is and who it's for" /></label>
        <div className="seg" style={{ alignSelf: 'flex-start' }}>
          <button type="button" aria-pressed={type === 'software'} onClick={() => setType('software')}>Software</button>
          <button type="button" aria-pressed={type === 'general'} onClick={() => setType('general')}>Anything else</button>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>Nothing is set up yet: no folder, board or team. Shape it in its chat when you're ready.</span>
        {error && <div className="error">{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" disabled={!title.trim()}>Save idea</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

export function IdeaBoard() {
  const ideas = useApi<IdeaCard[]>('/api/ideas', ideaEvents);
  const [capturing, setCapturing] = useState(false);
  const [showParked, setShowParked] = useState(false);
  const all = ideas.data ?? [];
  const parked = all.filter((i) => i.status === 'parked');
  const list = showParked ? parked : all.filter((i) => i.status !== 'parked');
  return (
    <section className="panel" aria-labelledby="ideas-h">
      <div className="panel-head">
        <h2 id="ideas-h">Idea board</h2>
        {parked.length > 0 && <button className="link-btn muted" style={{ fontSize: 12 }} onClick={() => setShowParked((v) => !v)}>{showParked ? 'Back to active ideas' : `${parked.length} parked`}</button>}
        <button className="btn sm" onClick={() => setCapturing(true)}>New idea</button>
      </div>
      {capturing && <CaptureIdeaDialog onClose={() => setCapturing(false)} />}
      {list.length === 0 ? (
        <div className="empty" style={{ padding: 18 }}>
          {showParked ? 'Nothing parked.' : 'No ideas yet. Mention one to the Main agent and it lands here, or add it yourself. Shape it in its chat; when it is ready, promote it to a project.'}
        </div>
      ) : (
        <div className="idea-grid">
          {list.map((i) => (
            <a key={i.id} className="idea-card" href={href(`/idea/${i.id}`)} onClick={go(`/idea/${i.id}`)}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</strong>
                {i.working && <span className="pill t-g" style={{ fontSize: 10.5 }}>live</span>}
                <span className={`pill ${STATUS[i.status].tone}`} style={{ fontSize: 10.5 }}>{STATUS[i.status].label}</span>
              </div>
              {i.pitch && <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.4 }}>{i.pitch}</div>}
              <Shaped i={i} />
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
