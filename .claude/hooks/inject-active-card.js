// UserPromptSubmit: inject the current in_progress card(s), if any.
import { api, projectIdFor, readStdin } from './lib.js';

const data = await readStdin();
const projectId = await projectIdFor(data.cwd ?? process.cwd());
if (!projectId) process.exit(0);

const active = (await api('GET', `/active?project=${projectId}`)) ?? [];
if (active.length === 0) process.exit(0); // nothing in flight — no noise

const cards = active.map((c) => {
  const who = [c.agent, c.skill && `skill:${c.skill}`].filter(Boolean).join(' · ');
  return `${c.id} "${c.title}"${who ? ` (${who})` : ''}`;
});
console.log(`[board] active: ${cards.join('; ')}`);
