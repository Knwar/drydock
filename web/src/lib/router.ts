import { useEffect, useState } from 'react';

const BASE = '/app';
const listeners = new Set<() => void>();
window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function navigate(to: string): void {
  history.pushState(null, '', BASE + to);
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
