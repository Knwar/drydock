// ── Dashboard widgets: Agentic cost (rework-cost, decision-latency-cost, cost-anomaly, usage-runway) ──
// Stub: registered with their real titles, sizes and ranged flags; load() returns null and render shows
// the standard empty state. The widget card for this group fills them in (dwRegister; see dashboard.js).

const AC_WIDGETS = [
  { type: 'rework-cost', title: 'What does rework cost?', sizes: ['S', 'M', 'L'], ranged: true },
  { type: 'decision-latency-cost', title: 'What does waiting on me cost?', sizes: ['S', 'M', 'L'], ranged: true },
  { type: 'cost-anomaly', title: 'Is any spend unusual?', sizes: ['S', 'M', 'L'], ranged: true },
  { type: 'usage-runway', title: 'Will we hit the usage limits?', sizes: ['S', 'M', 'L'], ranged: false },
];

for (const w of AC_WIDGETS) {
  dwRegister({
    ...w,
    load: async () => null,
    render: () => ({ empty: 'Coming soon' }),
  });
}
