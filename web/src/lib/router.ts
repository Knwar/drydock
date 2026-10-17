import { useEffect, useState } from 'react';

const BASE = '/app';
const listeners = new Set<() => void>();
window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  history[opts.replace ? 'replaceState' : 'pushState'](null, '', BASE + to);
  listeners.forEach((l) => l());
}

/** The open thread, from ?thread= in the address. */
export const threadParam = () => new URLSearchParams(location.search).get('thread');

export function usePath(): string[] {
  const read = () => location.pathname.replace(/^\/app/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const l = () => setParts(read());
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return parts;
}

/** onClick for an <a href>: client-side navigation, but cmd/ctrl-click still opens a tab. */
export function go(to: string) {
  return (e: { preventDefault(): void; metaKey: boolean; ctrlKey: boolean }) => {
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    navigate(to);
  };
}
export const href = (to: string) => BASE + to;

// Settings open in a window over whatever page you are on, kept in ?settings=<section>
// so the page underneath stays as it was and Back closes the window.
export const settingsParam = () => new URLSearchParams(location.search).get('settings');

function setSettings(section: string | null, push: boolean): void {
  const url = new URL(location.href);
  if (section) url.searchParams.set('settings', section);
  else url.searchParams.delete('settings');
  history[push ? 'pushState' : 'replaceState'](null, '', url.pathname + url.search + url.hash);
  listeners.forEach((l) => l());
}

let pushed = false;
/** Open the settings window (or switch its section without adding history). */
export function openSettings(section = 'integrations'): void {
  if (!settingsParam()) pushed = true;
  setSettings(section, !settingsParam());
}
/** Close it: step back if we opened it (so Back/Forward stay natural), else just drop the parameter. */
export function closeSettings(): void {
  if (pushed) {
    pushed = false;
    history.back();
  } else setSettings(null, false);
}
window.addEventListener('popstate', () => {
  if (!settingsParam()) pushed = false;
});
