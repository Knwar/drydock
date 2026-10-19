// Import an existing project: a folder already in projects/, a folder from
// elsewhere on this Mac (copied in), or a git repository (cloned). A review
// step shows what in it could run on its own before anything is set up.
import { useState } from 'react';
import { api, useApi } from '../lib/api';
import { Modal } from './Dialogs';

interface Inspection {
  dir: string;
  name: string;
  type: 'software' | 'general';
  files: number;
  bytes: number;
  truncated: boolean;
  git: { repo: boolean; branch: string | null; remote: string | null; dirty: number; commits: number } | null;
  risks: { claudeSettings: { file: string; hooks: string[]; permissions: boolean }[]; mcpServers: string[]; installScripts: string[]; envFiles: string[] };
  registered: boolean;
}

const size = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const folder = (dir: string) => dir.split('/').pop() ?? dir;

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (projectId: string, channel: string) => void }) {
  const [source, setSource] = useState<'workspace' | 'mac' | 'git'>('workspace');
  const cands = useApi<{ candidates: { dir: string; name: string; boardOnly: boolean }[] }>('/api/import/candidates');
  const [path, setPath] = useState('');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [outside, setOutside] = useState<Inspection | null>(null); // a folder elsewhere, before copying
  const [info, setInfo] = useState<Inspection | null>(null); // a folder in projects/, ready to import
  const [type, setType] = useState<'software' | 'general'>('software');
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const step = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const review = (i: Inspection) => {
    setInfo(i);
    setType(i.type);
    setName(i.name);
    setTrust(false);
  };
  const r = info?.risks;
  const risky = Boolean(r && (r.claudeSettings.length || r.mcpServers.length));

  if (info && r) {
    return (
      <Modal title={`Import ${folder(info.dir)}`} onClose={onClose} width={620}>
        <div className="form-grid">
          <label className="field"><span className="muted">Project name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div className="field">
            <span className="muted">Kind of project (detected: {info.type === 'software' ? 'software' : 'not code'})</span>
            <div className="seg" style={{ alignSelf: 'flex-start' }}>
              <button aria-pressed={type === 'software'} onClick={() => setType('software')}>Software</button>
              <button aria-pressed={type === 'general'} onClick={() => setType('general')}>Anything else</button>
            </div>
          </div>
        </div>
        <ul className="md-list" style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
          <li><span className="mono">projects/{folder(info.dir)}</span> · {info.files}{info.truncated ? '+' : ''} files · {size(info.bytes)}</li>
          <li>{info.git ? <>Git: {info.git.commits} commit{info.git.commits === 1 ? '' : 's'} on <span className="mono">{info.git.branch}</span>{info.git.remote && <> · remote <span className="mono">{info.git.remote}</span> (Drydock never pushes)</>}</> : 'No git history yet: Drydock starts one.'}</li>
        </ul>

        {info.git && info.git.dirty > 0 && (
          <div className="banner t-a" style={{ fontSize: 12.5, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: 1 }}>{info.git.dirty} uncommitted change(s). Card work starts from a clean state, so commit them first, or let Drydock commit them as a snapshot (.env files are kept out of it).</span>
            <button className="btn sm" disabled={busy !== null} onClick={() => step('snap', async () => review(await api<Inspection>('/api/import/snapshot', { body: { dir: folder(info.dir) } })))}>{busy === 'snap' ? 'Committing…' : 'Commit a snapshot'}</button>
          </div>
        )}

        <section className="panel" style={{ gap: 6, padding: '12px 14px' }}>
          <strong style={{ fontSize: 13 }}>What could run on its own</strong>
          {!risky && !r.installScripts.length && !r.envFiles.length && <span className="muted" style={{ fontSize: 12.5 }}>Nothing found: no Claude Code hooks, MCP servers, install scripts or .env files.</span>}
          {r.claudeSettings.map((s) => (
            <span key={s.file} style={{ fontSize: 12.5 }}>⚠️ <span className="mono">{s.file}</span>{s.hooks.length ? `: hooks on ${s.hooks.join(', ')} (commands that run when an agent starts or uses tools here)` : ''}{s.permissions ? ', pre-approved permissions' : ''}</span>
          ))}
          {r.mcpServers.length > 0 && <span style={{ fontSize: 12.5 }}>⚠️ MCP servers in <span className="mono">.mcp.json</span>: {r.mcpServers.join(', ')}</span>}
          {r.installScripts.map((s) => <span key={s} style={{ fontSize: 12.5 }}>Install script (runs only when you press Start): <span className="mono">{s}</span></span>)}
          {r.envFiles.length > 0 && <span style={{ fontSize: 12.5 }}>Secrets file(s): <span className="mono">{r.envFiles.join(', ')}</span>. Kept out of git; the Main agent asks before moving them into your password manager.</span>}
          {risky && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, marginTop: 4 }}>
              <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
              <span>I trust this project's own Claude settings and MCP servers. <span className="muted">Off (recommended): they are moved to <span className="mono">.ai-brain/quarantine/</span>, where you can restore them later.</span></span>
            </label>
          )}
        </section>

        <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>Then: the board kit is added (merged into any existing CLAUDE.md and settings), and the Main agent reads the project and writes "what exists today" as requirements v1{type === 'software' ? ', finds how to run and test it, and asks the Architect to draw the design from the code' : ''}. This uses your subscription. Nothing is installed or run until you press Start.</div>
        {error && <div className="error">{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn primary"
            disabled={busy !== null || Boolean(info.git?.dirty) || !name.trim()}
            title={info.git?.dirty ? 'Commit the uncommitted changes first' : undefined}
            onClick={() => step('import', async () => {
              const res = await api<{ id: string; channel: string }>('/api/import', { body: { dir: folder(info.dir), type, name, trust } });
              onImported(res.id, res.channel);
            })}
          >
            {busy === 'import' ? 'Importing…' : 'Import and onboard'}
          </button>
          <button className="btn" onClick={() => setInfo(null)}>Back</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Import a project" onClose={onClose} width={600}>
      <div className="seg" style={{ alignSelf: 'flex-start' }}>
        <button aria-pressed={source === 'workspace'} onClick={() => setSource('workspace')}>In projects/</button>
        <button aria-pressed={source === 'mac'} onClick={() => setSource('mac')}>From this Mac</button>
        <button aria-pressed={source === 'git'} onClick={() => setSource('git')}>From Git</button>
      </div>

      {source === 'workspace' && (
        <>
          <div className="muted" style={{ fontSize: 12.5 }}>Folders you put in the workspace's <span className="mono">projects/</span> folder that are not projects yet.</div>
          {cands.data?.candidates.length ? (
            cands.data.candidates.map((c) => (
              <div key={c.dir} className="check-row">
                <span className="mono" style={{ flex: 1, fontSize: 13 }}>projects/{c.name}</span>
                {c.boardOnly && <span className="pill t-n">on the board only</span>}
                <button className="btn sm" disabled={busy !== null} onClick={() => step(c.dir, async () => review(await api<Inspection>('/api/import/inspect', { body: { dir: c.name } })))}>{busy === c.dir ? 'Checking…' : 'Review'}</button>
              </div>
            ))
          ) : (
            <div className="empty" style={{ padding: 16 }}>None found. Put a folder in <span className="mono">projects/</span>, or use another source.</div>
          )}
        </>
      )}

      {source === 'mac' && (
        <>
          <div className="muted" style={{ fontSize: 12.5 }}>The folder is <strong>copied</strong> into <span className="mono">projects/</span> (agents never work outside the workspace). Dependencies and build output (node_modules, .venv, dist…) are left out and rebuilt on first start.</div>
          <label className="field"><span className="muted">Full path of the folder</span><input className="input mono" placeholder="/Users/you/code/my-app" value={path} onChange={(e) => (setPath(e.target.value), setOutside(null))} /></label>
          {outside && (
            <div className="banner t-b" style={{ fontSize: 12.5 }}>
              {outside.files}{outside.truncated ? '+' : ''} files, {size(outside.bytes)} to copy{outside.git ? `, with ${outside.git.commits} commit${outside.git.commits === 1 ? '' : 's'} of git history` : ''}.
            </div>
          )}
          <label className="field"><span className="muted">Name in Drydock</span><input className="input" placeholder={path.split('/').filter(Boolean).pop() ?? ''} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div style={{ display: 'flex', gap: 8 }}>
            {!outside ? (
              <button className="btn primary" disabled={!path.trim() || busy !== null} onClick={() => step('check', async () => setOutside(await api<Inspection>('/api/import/inspect', { body: { path: path.trim() } })))}>{busy === 'check' ? 'Checking…' : 'Check folder'}</button>
            ) : (
              <button className="btn primary" disabled={busy !== null} onClick={() => step('copy', async () => review(await api<Inspection>('/api/import/copy', { body: { path: path.trim(), name: name.trim() } })))}>{busy === 'copy' ? 'Copying…' : `Copy ${size(outside.bytes)} into projects/`}</button>
            )}
          </div>
        </>
      )}

      {source === 'git' && (
        <>
          <div className="muted" style={{ fontSize: 12.5 }}>Cloned into <span className="mono">projects/</span> with your own git sign-in. For private GitHub repositories, run <span className="mono">gh auth login</span> in a terminal first. Nothing is ever pushed.</div>
          <label className="field"><span className="muted">Repository address</span><input className="input mono" placeholder="https://github.com/you/repo.git or git@github.com:you/repo.git" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
          <label className="field"><span className="muted">Name in Drydock (optional)</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={!url.trim() || busy !== null} onClick={() => step('clone', async () => review(await api<Inspection>('/api/import/clone', { body: { url: url.trim(), name: name.trim() } })))}>{busy === 'clone' ? 'Cloning…' : 'Clone and review'}</button>
          </div>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}
