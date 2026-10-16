// Subscription usage (D4): read from the rate_limit_event each agent run
// reports. When usage crosses the alert threshold the app says so (and can
// push a notification); agents keep running.
import { execFile } from 'node:child_process';
import type { DB } from '../core/db.js';
import { getBus } from './bus.js';
import { getSetting, putSetting } from './settings.js';

export interface UsageAlert {
  threshold: number; // percent of the weekly window
  push: boolean;
}

export const usageAlert = (db: DB): UsageAlert => getSetting(db, 'brain.usage_alert', { threshold: 75, push: true });

export function getUsage(db: DB) {
  const ev = getSetting<any>(db, 'brain.rate_limit', null);
  const win = (w: any) => (w && typeof w.utilization === 'number' ? { pct: Math.round(w.utilization * 100), resets_at: w.resetsAt ? w.resetsAt * 1000 : null } : null);
  const windows = ev?.rate_limit_info?.unifiedWindows ?? {};
  const five = win(windows.five_hour);
  const week = win(windows.seven_day);
  const alert = usageAlert(db);
  return { five_hour: five, seven_day: week, at: ev?.at ?? null, threshold: alert.threshold, high: Boolean(week && week.pct >= alert.threshold) };
}

export function notify(title: string, body: string): void {
  if (process.platform !== 'darwin' || process.env.BRAIN_NO_NOTIFY) return;
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], () => {});
}

/** Store a fresh rate-limit event; alert once when the weekly window crosses the threshold. */
export function onRateLimit(db: DB, ev: any): void {
  const before = getUsage(db).high;
  putSetting(db, 'brain.rate_limit', { ...ev, at: Date.now() });
  const after = getUsage(db);
  if (after.high && !before && usageAlert(db).push) notify('AI Brain: usage high', `${after.seven_day?.pct}% of this week's limit used. Agents keep running.`);
  getBus().emit({ type: 'usage' });
}
