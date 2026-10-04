// ── Dashboard widgets: Agentic report (steering-pack, agent-hourly-rate, perception-gap) ──
// Stub: registered with their real titles, sizes and ranged flags; load() returns null and render shows
// the standard empty state. The widget card for this group fills them in (dwRegister; see dashboard.js).

const AR_WIDGETS = [
  // unranged: it uses its own report period (a param), not Home's range
  { type: 'steering-pack', title: 'Steering pack', sizes: ['M', 'L', 'XL'], ranged: false },
  { type: 'agent-hourly-rate', title: 'How much work does a dollar buy?', sizes: ['S', 'M', 'L'], ranged: true },
  { type: 'perception-gap', title: 'Are our estimates realistic?', sizes: ['S', 'M', 'L'], ranged: true },
];

for (const w of AR_WIDGETS) {
  dwRegister({
    ...w,
    load: async () => null,
    render: () => ({ empty: 'Coming soon' }),
  });
}
