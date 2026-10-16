// The Daily (D12): a morning edition the main agent writes from your
// calendar, email, projects and personal data. Always shown in the app;
// email, push and audio delivery are options in Settings.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../core/db.js';
import { getBus } from './bus.js';
import { addMessage, getConversation } from './chat.js';
import { respond } from './runner.js';
import { defineSchema } from './schema.js';
import { getSetting, putSetting } from './settings.js';
import { notify } from './usage.js';
import { currentWorkspace } from './workspace.js';

export const DAILY_CONVERSATION = 'sys:daily';

export interface DailySettings {
  time: string; // HH:MM
  days: number[]; // 0 = Sunday … 6 = Saturday
  email: boolean;
  push: boolean;
  audio: boolean;
  sections: { day: boolean; work: boolean; inbox: boolean; life: boolean; team: boolean };
}

const DEFAULTS: DailySettings = { time: '07:00', days: [1, 2, 3, 4, 5, 6], email: false, push: true, audio: false, sections: { day: true, work: true, inbox: true, life: true, team: true } };

defineSchema(
  `
CREATE TABLE IF NOT EXISTS daily_editions (
  day        TEXT PRIMARY KEY,   -- YYYY-MM-DD
  number     INTEGER NOT NULL,
  headline   TEXT NOT NULL,
  summary    TEXT,
  focus      TEXT,
  sections   TEXT NOT NULL,      -- JSON [{title, items:[{text, tone?}]}]
  audio      TEXT,               -- file under vault/personal/daily
  created_at INTEGER NOT NULL
);
`,
  (db) => {
    db.prepare(`INSERT OR IGNORE INTO conversations (id, kind, role_id, name, created_at, last_at) VALUES (?, 'dm', 'main', 'The Daily', ?, 0)`).run(DAILY_CONVERSATION, Date.now());
    db.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, role_id) VALUES (?, 'main')`).run(DAILY_CONVERSATION);
  },
);

export const dailySettings = (db: DB): DailySettings => ({ ...DEFAULTS, ...getSetting<Partial<DailySettings>>(db, 'brain.daily', {}) });

export function saveDailySettings(db: DB, patch: Partial<DailySettings>): DailySettings {
  const next = { ...dailySettings(db), ...patch, sections: { ...dailySettings(db).sections, ...(patch.sections ?? {}) } };
  if (!/^\d{2}:\d{2}$/.test(next.time)) throw new Error('time must be HH:MM');
  next.days = [...new Set(next.days.filter((d) => d >= 0 && d <= 6))].sort();
  putSetting(db, 'brain.daily', next);
  return next;
}

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function getEdition(db: DB, day?: string) {
  const row = (day ? db.prepare('SELECT * FROM daily_editions WHERE day = ?').get(day) : db.prepare('SELECT * FROM daily_editions ORDER BY day DESC LIMIT 1').get()) as any;
  return row ? { ...row, sections: JSON.parse(row.sections) } : null;
}

export function listEditions(db: DB, limit = 30) {
  return db.prepare('SELECT day, number, headline FROM daily_editions ORDER BY day DESC LIMIT ?').all(limit);
}

let generating = false;
export const isGenerating = () => generating;

/** Ask the main agent to write today's edition. It publishes through the publish_daily tool. */
export function generateDaily(db: DB): void {
  if (generating) return;
  const s = dailySettings(db);
  const day = localDay();
  const TITLES: Record<string, string> = { day: 'Your day', work: 'Work & projects', inbox: 'Inbox', life: 'Life & money', team: 'Team decisions' };
  const sections = Object.entries(s.sections).filter(([, on]) => on).map(([k]) => `"${TITLES[k] ?? k}"`);
  const prompt = [
    `Write today's edition of The Daily (${day}).`,
    '',
    'Gather, using the tools you have:',
    s.sections.day ? '- Today and this week from Google Calendar, if it is connected. Record them with record_calendar.' : '',
    s.sections.inbox || s.sections.life
      ? '- Email from the last 48 hours, if Gmail is connected: what needs action (replies owed, deadlines, invoices, meeting requests, personal threads). Record them with record_inbox. Record bills and receipts with record_money.'
      : '',
    s.sections.work ? '- Project status with list_projects.' : '',
    '- Open reminders with list_reminders.',
    s.sections.team ? '- Decisions agreed since yesterday with list_decisions.' : '',
    '',
    `Then call publish_daily once, with a one-sentence headline (the most important thing today), a 2–3 sentence summary, a focus for the day, and these sections, using exactly these titles: ${sections.join(', ')}. Each item is one short line; tag each with a tone (work, personal, social, money or alert).`,
    'If Gmail or Calendar is not connected, say so in one item and work with what you have. Never invent events, emails or amounts.',
    s.email ? "Finally, email the edition to the user's own address with Gmail (subject: \"The Daily · <date>\"). Send nothing else." : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
  generating = true;
  const m = addMessage(db, DAILY_CONVERSATION, 'system', prompt);
  getBus().emit({ type: 'chat', conversation: DAILY_CONVERSATION, message: m });
  getBus().emit({ type: 'daily', status: 'generating' });
  respond(DAILY_CONVERSATION, '', { model: 'sonnet', effort: 'low', onDone: () => {
    generating = false;
    getBus().emit({ type: 'daily', status: 'idle' });
  } });
}

/** From publish_daily: store the edition, write it to the vault, and deliver it. */
export function publishEdition(db: DB, e: { headline: string; summary?: string; focus?: string; sections: { title: string; items: { text: string; tone?: string }[] }[] }) {
  const day = localDay();
  const number = ((db.prepare('SELECT MAX(number) AS n FROM daily_editions').get() as { n: number | null }).n ?? 0) + (getEdition(db, day) ? 0 : 1);
  db.prepare(
    `INSERT INTO daily_editions (day, number, headline, summary, focus, sections, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET headline = excluded.headline, summary = excluded.summary, focus = excluded.focus, sections = excluded.sections, created_at = excluded.created_at`,
  ).run(day, Math.max(number, 1), e.headline, e.summary ?? null, e.focus ?? null, JSON.stringify(e.sections ?? []), Date.now());

  const ws = currentWorkspace();
  const md = [`# The Daily · ${day}`, '', `**${e.headline}**`, '', e.summary ?? '', '', e.focus ? `Focus: ${e.focus}` : '', '', ...(e.sections ?? []).flatMap((s) => [`## ${s.title}`, '', ...s.items.map((i) => `- ${i.text}`), ''])].join('\n');
  if (ws) {
    const dir = join(ws.vault, 'personal', 'daily');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${day}.md`), md);
    const s = dailySettings(db);
    if (s.audio && process.platform === 'darwin') {
      const text = [e.headline, e.summary ?? '', e.focus ? `Your focus today: ${e.focus}.` : '', ...(e.sections ?? []).flatMap((x) => [x.title + '.', ...x.items.map((i) => i.text + '.')])].join(' ');
      const file = join(dir, `${day}.aiff`);
      const m4a = join(dir, `${day}.m4a`);
      execFile('say', ['-o', file, text], (err) => {
        if (err) return;
        execFile('afconvert', ['-f', 'm4af', '-d', 'aac', file, m4a], (err2) => {
          const out = !err2 && existsSync(m4a) ? `${day}.m4a` : `${day}.aiff`;
          getBus().db().prepare('UPDATE daily_editions SET audio = ? WHERE day = ?').run(out, day);
          getBus().emit({ type: 'daily', status: 'published' });
        });
      });
    }
    if (s.push) notify('The Daily', e.headline);
  }
  getBus().emit({ type: 'daily', status: 'published' });
  return getEdition(db, day);
}

/** Every minute: publish today's edition once, at or after the set time, on the chosen days. */
export function startDailyScheduler(): NodeJS.Timeout {
  return setInterval(() => {
    try {
      if (!currentWorkspace()) return;
      const db = getBus().db();
      if (!getConversation(db, DAILY_CONVERSATION)) return;
      const s = dailySettings(db);
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const today = localDay(now);
      if (!s.days.includes(now.getDay()) || hhmm < s.time || getEdition(db, today) || generating) return;
      if (getSetting(db, 'brain.daily_attempt', '') === today) return; // one automatic try a day
      putSetting(db, 'brain.daily_attempt', today);
      generateDaily(db);
    } catch (err) {
      console.error(`daily scheduler: ${(err as Error).message}`);
    }
  }, 60_000);
}
