import { useCallback, useEffect, useState } from 'react';
import { onLive } from './live';

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const send = () =>
    fetch(path, {
      method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  let res = await send();
  // a tab opened before the daemon (re)started has no session yet: get one and try once more
  if (res.status === 401) {
    await fetch('/api/session');
    res = await send();
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

/** GET a resource, refetching when a live event matching `refreshOn` arrives. */
export function useApi<T>(path: string | null, refreshOn: (msg: any) => boolean = () => true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    api<T>(path)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path, tick]);
  useEffect(() => onLive((msg) => refreshOn(msg) && reload()), [reload]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload, setData };
}
