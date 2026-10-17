import { StageSteps } from '../components/Shell';
import { api, useApi } from '../lib/api';
import { go, href } from '../lib/router';
import { DailyCard, personalEvents, type PersonalData } from './Personal';
import type { ProjectSummary } from '../lib/types';

function ProjectsPanel({ projects, onImport }: { projects: ProjectSummary[]; onImport: () => void }) {
  const found = useApi<{ candidates: { name: string }[] }>('/api/import/candidates', (m) => ['workspace', 'brain_project'].includes(m?.type));
  const waiting = found.data?.candidates ?? [];
  return (
    <section className="panel" aria-labelledby="proj-h">
      <div className="panel-head">
        <h2 id="proj-h">Projects</h2>
        <button className="btn sm" onClick={onImport}>Import a project</button>
      </div>
      {waiting.length > 0 && (
        <div className="banner t-b" style={{ fontSize: 12.5, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1 }}>Found {waiting.length === 1 ? <span className="mono">projects/{waiting[0].name}</span> : `${waiting.length} folders`} in the workspace that {waiting.length === 1 ? 'is' : 'are'} not a project yet.</span>
          <button className="btn sm" onClick={onImport}>Review</button>
        </div>
      )}
      {projects.length === 0 ? (
        <div className="empty">No projects yet. Tell the main agent about an idea and it will offer to set one up.</div>
      ) : (
        <div className="scroll-x">
          <div style={{ minWidth: 600 }}>
            {projects.map((p) => {
              const pct = p.cards.total ? Math.round((p.cards.done / p.cards.total) * 100) : 0;
              const status = p.blocked
                ? `${p.blocked} card${p.blocked > 1 ? 's' : ''} blocked`
                : p.phase
                  ? `Phase ${p.phase.index}/${p.phase.count} · ${p.phase.title}`
                  : p.description || 'Not planned yet';
              const tone = p.blocked ? 'var(--r-fg)' : p.liveAgents ? 'var(--g-fg)' : 'var(--n-fg)';
              return (
                <a key={p.id} className="proj-row" href={href(`/project/${p.id}`)} onClick={go(`/project/${p.id}`)}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {p.verticals.length ? p.verticals.map((v) => v.name).join(' · ') : 'not split yet'}
                    </div>
                  </div>
                  <StageSteps stage={p.stage} type={p.type} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{status}</span>
                      <span className="mono muted">{p.cards.total ? `${p.cards.done}/${p.cards.total}` : '—'}</span>
                    </div>
                    <div className="bar">
                      <div style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <div className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', fontSize: 12 }}>
                    <span className="dot" style={{ background: tone }} />
                    {p.liveAgents === 1 ? '1 agent' : `${p.liveAgents} agents`}
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

const TONE: Record<string, string> = { work: 'b', personal: 'g', social: 'v', reminder: 'a' };

function Today({ data }: { data: PersonalData }) {
  const events = data.week.events.filter((e) => e.day === data.today);
  const due = data.reminders.filter((r) => !r.done && r.due && r.due.slice(0, 10) <= data.today);
  const items = [
    ...events.map((e) => ({ key: e.id, time: e.time ?? 'All day', title: e.title, meta: e.meta ?? '', tone: TONE[e.category] ?? 'b' })),
    ...due.map((r) => ({ key: `r${r.id}`, time: r.due!.slice(11, 16) || 'Today', title: r.text, meta: r.due!.slice(0, 10) < data.today ? 'Overdue reminder' : 'Reminder', tone: 'a', id: r.id })),
  ].sort((a, b) => a.time.localeCompare(b.time));
  return (
    <section className="panel" aria-labelledby="today-h">
      <div className="panel-head">
        <h2 id="today-h">Today</h2>
        <a className="btn sm" href={href('/personal')} onClick={go('/personal')}>Week and more</a>
      </div>
      {items.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>Nothing scheduled. Calendar events appear after the Daily runs with Google Calendar connected; reminders you add show here on their day.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', columnGap: 24 }}>
          {items.map((i: any) => (
            <div key={i.key} style={{ display: 'grid', gridTemplateColumns: '50px 3px minmax(0,1fr)', gap: 12, padding: '7px 0' }}>
              <span className="mono muted" style={{ fontSize: 12, paddingTop: 2 }}>{i.time}</span>
              <span style={{ borderRadius: 2, background: `var(--${i.tone}-fg)` }} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontWeight: 500 }}>{i.title}</span>
                <span className="muted" style={{ fontSize: 12 }}>{i.meta}{i.id ? <> · <button className="link-btn" onClick={() => api(`/api/reminders/${i.id}`, { body: { done: true } })}>done</button></> : null}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function Home({ projects, onImport }: { projects: ProjectSummary[]; onImport: () => void }) {
  const personal = useApi<PersonalData>('/api/personal', personalEvents);
  return (
    <>
      {personal.data && <DailyCard edition={personal.data.edition} generating={personal.data.generating} compact />}
      <ProjectsPanel projects={projects} onImport={onImport} />
      {personal.data && <Today data={personal.data} />}
    </>
  );
}
