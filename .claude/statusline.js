// Claude Code status line. Prints the CLI status line AND forwards the
// subscription rate limits to the board daemon for the overlay's usage
// bars. Zero extra Anthropic calls: this only reads what Claude Code
// already pipes in on its own refresh cycle. Daemon-forward is throttled
// to "changed, or 120s elapsed" — and is best-effort (daemon down = fine).
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const THROTTLE_MS = 120_000;
const STATE = join(tmpdir(), 'knwr-usage-last.json');
const DAEMON = process.env.DAEMON_URL ?? 'http://localhost:7900';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let data = {};
try {
  data = JSON.parse(raw);
} catch {
  /* keep going — still print something */
}

const model = data.model?.display_name ?? data.model?.id ?? 'claude';
const five = data.rate_limits?.five_hour?.used_percentage;
const week = data.rate_limits?.seven_day?.used_percentage;
const pct = (v) => (typeof v === 'number' ? `${Math.round(v)}%` : '—');

// the visible CLI status line
console.log(`${model} | 5h ${pct(five)} | wk ${pct(week)}`);

// forward to the daemon (throttled)
if (data.rate_limits && (typeof five === 'number' || typeof week === 'number')) {
  let last = null;
  try {
    last = JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    /* first run */
  }
  const changed = !last || last.five !== five || last.week !== week;
  const stale = !last || Date.now() - last.at >= THROTTLE_MS;
  if (changed || stale) {
    try {
      await fetch(`${DAEMON}/usage`, {
        method: 'POST',
        body: JSON.stringify(data.rate_limits),
        signal: AbortSignal.timeout(1000),
      });
      writeFileSync(STATE, JSON.stringify({ at: Date.now(), five, week }));
    } catch {
      /* daemon down — never break the status line */
    }
  }
}
