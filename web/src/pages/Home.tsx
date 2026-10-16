import { StageSteps } from '../components/Shell';
import { go, href } from '../lib/router';
import type { ProjectSummary } from '../lib/types';

function ProjectsPanel({ projects }: { projects: ProjectSummary[] }) {
  return (
    <section className="panel" aria-labelledby="proj-h">
      <div className="panel-head">
        <h2 id="proj-h">Projects</h2>
        <span className="eyebrow">Idea · Create · Reqs · Design · Plan · Build</span>
      </div>
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
                  <StageSteps stage={p.stage} />
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

export function Home({ projects }: { projects: ProjectSummary[] }) {
  return (
    <>
      <ProjectsPanel projects={projects} />
      <section className="panel" aria-labelledby="today-h">
        <div className="panel-head">
          <h2 id="today-h">Today</h2>
        </div>
        <div className="empty">Your calendar and email will show here once Gmail and Google Calendar are connected in Settings.</div>
      </section>
    </>
  );
}
