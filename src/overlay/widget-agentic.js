// ── Dashboard widgets: Agentic (autonomy-index, agent-stops, batch-size, spec-adherence, governance-posture) ──
// Stub: registered with their real titles, sizes and ranged flags; load() returns null and render shows
// the standard empty state. The widget card for this group fills them in (dwRegister; see dashboard.js).

const AG_WIDGETS = [
  { type: 'autonomy-index', title: 'How autonomous are the agents?', sizes: ['S', 'M', 'L'], ranged: true },
  { type: 'agent-stops', title: 'Who stops the agents?', sizes: ['S', 'M', 'L'], ranged: true },
  { type: 'batch-size', title: 'Are changes small enough to review?', sizes: ['S', 'M', 'L'], ranged: true },
  { type: 'spec-adherence', title: 'Do agents build to spec?', sizes: ['S', 'M', 'L'], ranged: true },
  { type: 'governance-posture', title: 'Is agent work governed?', sizes: ['S', 'M', 'L'], ranged: true },
];

for (const w of AG_WIDGETS) {
  dwRegister({
    ...w,
    load: async () => null,
    render: () => ({ empty: 'Coming soon' }),
  });
}
