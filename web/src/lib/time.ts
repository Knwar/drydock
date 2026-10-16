/** A message time: "14:05" today, "Yesterday 14:05", else "12 Oct 14:05". */
export function when(t: number, now = new Date()): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => x.toDateString();
  if (day(d) === day(now)) return time;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (day(d) === day(y)) return `Yesterday ${time}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })} ${time}`;
}

/** Today's date as YYYY-MM-DD in local time. */
export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
