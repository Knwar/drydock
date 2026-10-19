// What AI Brain needs on this computer (Node, git, the Claude CLI, a Claude
// sign-in): a banner across the app while something is missing, and the
// full checklist on the welcome screen.
import { useState } from 'react';
import { api, useApi } from '../lib/api';

interface Check {
  id: string;
  ok: boolean;
  label: string;
  detail: string;
  fix: string | null;
  command: string | null;
}
interface Status {
  ok: boolean;
  checks: Check[];
}

function useSystem() {
  const s = useApi<Status>('/api/system', (m) => m?.type === 'system');
  const [checking, setChecking] = useState(false);
  const again = async () => {
    setChecking(true);
    try {
      await api('/api/system?refresh=1');
      s.reload();
    } finally {
      setChecking(false);
    }
  };
  return { data: s.data, checking, again };
}

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="sys-cmd">
      <code>{text}</code>
      <button type="button" className="link-btn" onClick={() => void navigator.clipboard?.writeText(text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>{copied ? 'Copied' : 'Copy'}</button>
    </span>
  );
}

/** Across the top of the app while agents cannot run. */
export function SystemBanner() {
  const { data, checking, again } = useSystem();
  if (!data || data.ok) return null;
  const failing = data.checks.filter((c) => !c.ok && c.fix);
  const signin = failing.some((c) => c.id === 'signin');
  return (
    <div className="sys-banner" role="alert">
      <strong>{signin && failing.length === 1 ? 'Claude isn’t signed in: agents can’t run.' : 'AI Brain is missing something it needs: agents can’t run.'}</strong>
      {failing.map((c) => (
        <span key={c.id} className="sys-item">
          <span>{c.label}: {c.detail}. {c.fix}</span>
          {c.command && <Command text={c.command} />}
        </span>
      ))}
      <button type="button" className="btn sm" disabled={checking} onClick={again}>{checking ? 'Checking…' : 'Check again'}</button>
    </div>
  );
}

/** Every check with a tick or a cross (the welcome screen). */
export function SystemChecklist() {
  const { data, checking, again } = useSystem();
  if (!data) return <div className="muted" style={{ fontSize: 12.5 }}>Checking this computer…</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>What AI Brain needs</span>
        {!data.ok && <button type="button" className="btn sm" disabled={checking} onClick={again}>{checking ? 'Checking…' : 'Check again'}</button>}
      </div>
      {data.checks.map((c) => (
        <div key={c.id} className="sys-row">
          <span className={`sys-mark ${c.ok ? 'ok' : 'bad'}`} aria-label={c.ok ? 'ready' : 'missing'}>{c.ok ? '✓' : '!'}</span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span><strong>{c.label}</strong> <span className="muted">{c.detail}</span></span>
            {!c.ok && c.fix && <span className="muted" style={{ fontSize: 12 }}>{c.fix}</span>}
            {!c.ok && c.command && <Command text={c.command} />}
          </span>
        </div>
      ))}
    </div>
  );
}
