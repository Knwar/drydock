// One idea: what has been shaped so far (requirements, system design, brand,
// UI mockups) beside its single chat. Every message in the chat can change
// several of these at once; the tabs update live. Promote makes a project.
import { useEffect, useState } from 'react';
import { ChatPanel } from '../components/Chat';
import { Modal } from '../components/Dialogs';
import { ideaEvents, Shaped, STATUS } from '../components/Ideas';
import { api, useApi } from '../lib/api';
import { Markdown } from '../lib/md';
import { go, href, navigate } from '../lib/router';
import type { Conversation, IdeaCard, ProjectSummary, Role } from '../lib/types';
import { SystemDesign } from './ProjectPage';

interface Detail extends IdeaCard {
  requirements: { version: number; markdown: string } | null;
  brand: (IdeaCard['brand'] & { guidelines: string; tokens: Record<string, any> }) | null;
  screenList: { id: string; title: string }[];
}

/** Colour tokens, flattened to name → value (nested groups become "group.name"). */
function colours(tokens: Record<string, any>, prefix = ''): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(tokens ?? {})) {
    const name = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') out.push(...colours(v, name));
    else if (typeof v === 'string' && /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\()/i.test(v.trim())) out.push([name, v.trim()]);
  }
  return out;
}

function Brand({ d }: { d: Detail }) {
  if (!d.brand) return <div className="empty" style={{ padding: 30 }}>No brand yet. Ask in the chat (for example "give it a calm, friendly brand"); the Main agent writes the guidelines and tokens.</div>;
  const sw = colours(d.brand.tokens);
  const fonts = Object.entries((d.brand.tokens?.font ?? d.brand.tokens?.typography ?? {}) as Record<string, any>).filter(([, v]) => typeof v === 'string');
  return (
    <>
      {sw.length > 0 && (
        <section className="panel">
          <div className="panel-head"><h2>Colours</h2><span className="muted" style={{ fontSize: 12 }}>{d.brand.name}</span></div>
          <div className="swatches">
            {sw.map(([n, v]) => (
              <div key={n} className="swatch"><span style={{ background: v }} /><strong>{n}</strong><span className="mono muted">{v}</span></div>
            ))}
          </div>
          {fonts.length > 0 && fonts.map(([n, v]) => <div key={n} style={{ fontFamily: v, fontSize: 18 }}>{n}: The quick brown fox <span className="mono muted" style={{ fontSize: 11 }}>{v}</span></div>)}
        </section>
      )}
      <section className="panel"><Markdown text={d.brand.guidelines || '_No guidelines written yet._'} /></section>
    </>
  );
}

function Screens({ d }: { d: Detail }) {
  const [cur, setCur] = useState<string | null>(null);
  const [width, setWidth] = useState<'mobile' | 'desktop'>('desktop');
  const [stamp, setStamp] = useState(0);
  useEffect(() => setStamp(Date.now()), [d.screens, d.updated_at]);
  const screen = d.screenList.find((s) => s.id === cur) ?? d.screenList[0];
  if (!screen) return <div className="empty" style={{ padding: 30 }}>No screens yet. Ask in the chat (for example "sketch the home and settings screens"); the Main agent draws them as clickable mockups.</div>;
  return (
    <section className="panel" style={{ gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="seg" role="tablist" aria-label="Screens">
          {d.screenList.map((s) => <button key={s.id} aria-pressed={s.id === screen.id} onClick={() => setCur(s.id)}>{s.title}</button>)}
        </div>
        <div className="seg" style={{ marginLeft: 'auto' }}>
          <button aria-pressed={width === 'mobile'} onClick={() => setWidth('mobile')}>Mobile</button>
          <button aria-pressed={width === 'desktop'} onClick={() => setWidth('desktop')}>Desktop</button>
        </div>
      </div>
      <div className="mockup-stage">
        {/* fully sandboxed and served without scripts: links between screens work, nothing else can */}
        <iframe key={`${screen.id}-${stamp}`} title={`${screen.title} mockup`} sandbox="" src={`/api/ideas/${d.id}/ui/${screen.id}.html?v=${stamp}`} style={{ width: width === 'mobile' ? 390 : '100%' }} />
      </div>
    </section>
  );
}

export function IdeaPage({ id, tab, sub, roles, conversations, projects }: { id: string; tab: string; sub: string | null; roles: Role[]; conversations: Conversation[]; projects: ProjectSummary[] }) {
  const idea = useApi<Detail>(`/api/ideas/${id}`, (m) => ideaEvents(m));
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [pitch, setPitch] = useState('');
  const [modal, setModal] = useState<'promote' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = idea.data;
  // the idea's one chat exists as soon as you open it (opening it costs nothing)
  useEffect(() => {
    if (d && !d.conversation_id && d.status !== 'promoted') void api(`/api/ideas/${id}/thread`, { method: 'POST' });
  }, [d?.conversation_id, d?.status, id]);
  if (idea.error) return <div className="empty">This idea is gone. <a href={href('/')} onClick={go('/')}>Back to Home</a></div>;
  if (!d) return null;
  const conv = conversations.find((c) => c.id === d.conversation_id) ?? null;
  const software = d.type === 'software';
  const tabs: [string, string][] = [['', 'Overview'], ...(software ? ([['design', 'System design']] as [string, string][]) : []), ['brand', 'Brand'], ...(software ? ([['ui', 'UI']] as [string, string][]) : [])];
  const base = `/idea/${id}`;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const promoted = d.status === 'promoted';
  return (
    <div className="idea-page">
      <div className="idea-main">
        <div className="eyebrow" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <a href={href('/')} onClick={go('/')}>Idea board</a> ›
          <span className={`pill ${STATUS[d.status].tone}`}>{STATUS[d.status].label}</span>
          <span className="pill t-n">{software ? 'Software' : 'General'}</span>
          {d.working && <span className="pill t-g">agents working</span>}
        </div>
        {editing ? (
          <form className="form-grid" onSubmit={(e) => (e.preventDefault(), act(async () => { await api(`/api/ideas/${id}`, { body: { title, pitch } }); setEditing(false); }))}>
            <label className="field"><span className="muted">Title</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
            <label className="field"><span className="muted">In one line</span><input className="input" value={pitch} onChange={(e) => setPitch(e.target.value)} /></label>
            <div style={{ display: 'flex', gap: 8 }}><button className="btn sm primary" disabled={busy || !title.trim()}>Save</button><button type="button" className="btn sm" onClick={() => setEditing(false)}>Cancel</button></div>
          </form>
        ) : (
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <h1 style={{ margin: '2px 0 4px', fontSize: 26 }}>{d.title}</h1>
              <div className="muted" style={{ fontSize: 14 }}>{d.pitch || 'No one-line pitch yet.'}</div>
              <div style={{ marginTop: 8 }}><Shaped i={d} /></div>
            </div>
            {promoted ? (
              <a className="btn primary" href={href(`/project/${d.project_id}`)} onClick={go(`/project/${d.project_id}`)}>Open the project</a>
            ) : (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="btn primary" disabled={busy} onClick={() => setModal('promote')}>Promote to project</button>
                <button className="btn" disabled={busy} onClick={() => (setTitle(d.title), setPitch(d.pitch), setEditing(true))}>Edit</button>
                <button className="btn" disabled={busy} onClick={() => act(() => api(`/api/ideas/${id}`, { body: { status: d.status === 'parked' ? 'shaping' : 'parked' } }))}>{d.status === 'parked' ? 'Bring back' : 'Park'}</button>
                <button className="btn" style={{ color: 'var(--r-fg)' }} disabled={busy} onClick={() => setModal('delete')}>Delete</button>
              </div>
            )}
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <nav className="tabs" aria-label="Idea">
          {tabs.map(([t, label]) => (
            <a key={t} className={`tab${tab === t ? ' on' : ''}`} aria-current={tab === t ? 'page' : undefined} href={href(t ? `${base}/${t}` : base)} onClick={go(t ? `${base}/${t}` : base)}>{label}</a>
          ))}
        </nav>
        {tab === '' && (
          <section className="panel">
            {d.requirements ? <Markdown text={d.requirements.markdown} /> : <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.6 }}>Tell the Main agent about the idea in the chat: the problem, who it is for, how you see it working. The requirements appear here and grow with every message. The system design, brand and UI fill in as the conversation touches them.</div>}
          </section>
        )}
        {tab === 'design' && software && <SystemDesign p={{ id, name: d.title, stage: 'idea', channels: [] }} focus={sub} openConversation={() => undefined} base={`${base}/design`} empty={'No system design yet. Ask in the chat (for example "how would this be built?"); the Main agent draws it here.'} />}
        {tab === 'brand' && <Brand d={d} />}
        {tab === 'ui' && software && <Screens d={d} />}
      </div>
      <aside className="idea-chat" aria-label="Idea chat">
        {conv ? <ChatPanel conversation={conv} roles={roles} projects={projects} onClose={() => navigate('/')} /> : <div className="muted" style={{ padding: 20, fontSize: 13 }}>{promoted ? 'This idea is a project now.' : 'Opening the chat…'}</div>}
      </aside>
      {modal === 'promote' && (
        <Modal title={`Promote "${d.title}" to a project?`} onClose={() => setModal(null)}>
          <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            This creates the project folder, its git repository and board. What was shaped goes with it:
            <ul className="md-list" style={{ margin: '6px 0' }}>
              <li>{d.requirementsVersion ? `Requirements v${d.requirementsVersion}, marked final` : 'Requirements: none yet (a placeholder is created)'}</li>
              {software && <li>{d.designElements ? `System design: ${d.designElements} elements (the design stage is skipped)` : 'System design: none yet (the Architect designs it in the project)'}</li>}
              <li>{d.brand ? `Brand: ${d.brand.name} (in docs/brand.md)` : 'Brand: none'}</li>
              {software && <li>{d.screens ? `UI: ${d.screens} screens (in docs/ui/)` : 'UI: none'}</li>}
            </ul>
            Next you pick the team, then the PM lays out the plan on the board. Later changes to these go through change requests you approve.
          </div>
          {d.missing.length > 0 && <div className="banner t-a" style={{ fontSize: 12.5 }}>Not shaped yet: {d.missing.join(', ')}. You can still promote it.</div>}
          {error && <div className="error">{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" autoFocus disabled={busy} onClick={() => act(async () => { const r = await api<{ project_id: string }>(`/api/ideas/${id}/promote`, { method: 'POST' }); setModal(null); navigate(`/project/${r.project_id}`); })}>{busy ? 'Creating the project…' : 'Promote to project'}</button>
            <button className="btn" onClick={() => setModal(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {modal === 'delete' && (
        <Modal title={`Delete "${d.title}"?`} onClose={() => setModal(null)}>
          <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>It leaves the Idea board. Its files move to <span className="mono">vault/ideas/.deleted/</span>, so nothing is lost by accident. Park it instead if you might come back to it.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn danger" autoFocus disabled={busy} onClick={() => act(async () => { await api(`/api/ideas/${id}`, { method: 'DELETE' }); setModal(null); navigate('/'); })}>Delete idea</button>
            <button className="btn" onClick={() => setModal(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
