// C4 view generated from the design model (one model, many views): the
// focused element's children inside a labelled boundary, connected neighbours
// greyed outside it, and relations rolled up to whatever is visible here.
// Layout by ELK (layered, top-down, orthogonal edges).
import ELK from 'elkjs/lib/elk.bundled.js';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface Element {
  id: string;
  parent_id: string | null;
  kind: 'person' | 'container' | 'component' | 'store' | 'queue' | 'external';
  name: string;
  technology: string | null;
  description: string | null;
  responsibilities: string | null;
  interfaces: string | null;
  risks: string | null;
  status: string;
}
export interface Relation {
  id: string;
  source: string;
  target: string;
  label: string;
  technology: string | null;
  interaction: 'sync' | 'async';
}

const elk = new ELK();
const NODE_W = 210;
const NODE_H = 112;
const KIND_LABEL: Record<string, string> = { person: 'Person', container: 'Container', component: 'Component', store: 'Container: data store', queue: 'Container: queue', external: 'External system' };

interface ViewNode { el: Element; out: boolean; drill: number; x: number; y: number }
interface ViewEdge { id: string; points: [number, number][]; labels: { text: string; full: string; x: number; y: number; tech: string | null }[]; async: boolean }
interface Layout { width: number; height: number; nodes: ViewNode[]; edges: ViewEdge[]; boundary: { x: number; y: number; w: number; h: number } | null }

export function buildView(elements: Element[], relations: Relation[], focus: string | null) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const parentOf = (id: string) => byId.get(id)?.parent_id ?? null;
  const ancestors = (id: string) => {
    const out: string[] = [];
    for (let cur: string | null = id; cur; cur = parentOf(cur)) out.push(cur);
    return out; // self first
  };
  const inside = elements.filter((e) => e.parent_id === focus && (focus !== null || (e.kind !== 'person' && e.kind !== 'external')));
  const outsideTop = focus === null ? elements.filter((e) => e.parent_id === null && (e.kind === 'person' || e.kind === 'external')) : [];
  const insideIds = new Set(inside.map((e) => e.id));
  // the element that represents `id` in this view: a child of the focus, or a top-level element outside it
  const visible = (id: string): string | null => {
    const chain = ancestors(id);
    const local = chain.find((a) => insideIds.has(a));
    if (local) return local;
    if (focus && chain.includes(focus)) return null; // the focus itself
    return chain[chain.length - 1];
  };
  const edges = new Map<string, { source: string; target: string; labels: Set<string>; tech: Set<string>; async: boolean }>();
  const neighbours = new Set<string>();
  for (const r of relations) {
    const s = visible(r.source);
    const t = visible(r.target);
    if (!s || !t || s === t) continue;
    if (!insideIds.has(s) && !insideIds.has(t)) continue;
    if (!insideIds.has(s)) neighbours.add(s);
    if (!insideIds.has(t)) neighbours.add(t);
    const key = `${s}>${t}`;
    const e = edges.get(key) ?? { source: s, target: t, labels: new Set(), tech: new Set(), async: true };
    e.labels.add(r.label);
    if (r.technology) e.tech.add(r.technology);
    e.async = e.async && r.interaction === 'async';
    edges.set(key, e);
  }
  const childCount = (id: string) => elements.filter((e) => e.parent_id === id).length;
  for (const o of outsideTop) neighbours.add(o.id);
  return {
    inside,
    neighbours: [...neighbours].map((id) => byId.get(id)!).filter(Boolean),
    edges: [...edges.values()].map((e) => {
      const full = [...e.labels].join('; ');
      return { ...e, full, label: full.length > 30 ? full.slice(0, 29).trimEnd() + '…' : full, techLabel: [...e.tech].join(', ').slice(0, 30) || null };
    }),
    childCount,
  };
}

async function layout(elements: Element[], relations: Relation[], focus: string | null): Promise<Layout> {
  const v = buildView(elements, relations, focus);
  const node = (e: Element) => ({ id: e.id, width: NODE_W, height: NODE_H });
  const charW = 6.2;
  const graph: any = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.nodeNode': '50',
      'elk.spacing.edgeLabel': '6',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.layered.edgeLabels.sideSelection': 'ALWAYS_DOWN',
    },
    children: [
      { id: '__boundary', layoutOptions: { 'elk.padding': '[top=28,left=24,bottom=44,right=24]' }, children: v.inside.map(node) },
      ...v.neighbours.map(node),
    ],
    edges: v.edges.map((e, i) => ({
      id: `e${i}`,
      sources: [e.source],
      targets: [e.target],
      labels: [{ text: e.label, width: Math.max(60, Math.max(e.label.length, (e.techLabel ?? '').length + 2) * charW), height: e.techLabel ? 30 : 16 }],
    })),
  };
  const out = await elk.layout(graph);
  const nodes: ViewNode[] = [];
  let boundary: Layout['boundary'] = null;
  const neighbourIds = new Set(v.neighbours.map((n) => n.id));
  const byId = new Map(elements.map((e) => [e.id, e]));
  const walk = (n: any, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + c.x;
      const y = oy + c.y;
      if (c.id === '__boundary') {
        boundary = { x, y, w: c.width, h: c.height };
        walk(c, x, y);
      } else {
        const el = byId.get(c.id)!;
        nodes.push({ el, out: neighbourIds.has(c.id) && el.kind !== 'person', drill: v.childCount(c.id), x, y });
      }
    }
  };
  walk(out, 0, 0);
  const edges: ViewEdge[] = (out.edges ?? []).map((e: any, i: number) => {
    // with INCLUDE_CHILDREN, edge coordinates are relative to the edge's container
    const container = e.container && e.container !== 'root' && boundary ? boundary : { x: 0, y: 0 };
    const pts: [number, number][] = [];
    for (const s of e.sections ?? []) {
      pts.push([s.startPoint.x + container.x, s.startPoint.y + container.y]);
      for (const b of s.bendPoints ?? []) pts.push([b.x + container.x, b.y + container.y]);
      pts.push([s.endPoint.x + container.x, s.endPoint.y + container.y]);
    }
    return {
      id: e.id,
      points: pts,
      async: v.edges[i].async,
      labels: (e.labels ?? []).map((l: any) => ({ text: l.text, full: v.edges[i].full, tech: v.edges[i].techLabel, x: (l.x ?? 0) + container.x, y: (l.y ?? 0) + container.y })),
    };
  });
  return { width: out.width ?? 600, height: out.height ?? 400, nodes, edges, boundary };
}

function shapeClass(k: string) {
  return k === 'person' ? 'c4-person' : k === 'store' ? 'c4-store' : k === 'queue' ? 'c4-queue' : 'c4-box';
}

export function Diagram({ elements, relations, focus, selected, onSelect, onDrill, focusName }: {
  elements: Element[];
  relations: Relation[];
  focus: string | null;
  selected: string | null;
  onSelect: (id: string) => void;
  onDrill: (id: string) => void;
  focusName: string;
}) {
  const [lay, setLay] = useState<Layout | null>(null);
  const [avail, setAvail] = useState(0);
  const [fit, setFit] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth - 24));
    ro.observe(el);
    return () => ro.disconnect();
  }, [lay !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const [error, setError] = useState<string | null>(null);
  const key = useMemo(() => JSON.stringify([elements, relations, focus]), [elements, relations, focus]);
  useEffect(() => {
    let alive = true;
    layout(elements, relations, focus)
      .then((l) => alive && (setLay(l), setError(null)))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="error">Layout failed: {error}</div>;
  if (!lay) return <div className="muted" style={{ padding: 24 }}>Laying out…</div>;
  if (!lay.nodes.length) return <div className="empty">Nothing at this level yet.</div>;
  const pad = 16;
  const focusEl = elements.find((e) => e.id === focus);
  const W = lay.width + pad * 2;
  const H = lay.height + pad * 2;
  const scale = fit && avail > 0 ? Math.max(0.75, Math.min(1, avail / W)) : 1;
  return (
    <div className="c4-scroll" ref={boxRef}>
      <button className="btn sm c4-zoom" onClick={() => setFit(!fit)} title={fit ? 'Show at full size' : 'Fit to width'}>{fit ? '100%' : 'Fit'}</button>
      <div style={{ width: W * scale, height: H * scale, margin: '0 auto' }}>
      <div className="c4-canvas" style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
        {lay.boundary && (
          <div className="c4-boundary" style={{ left: lay.boundary.x + pad, top: lay.boundary.y + pad, width: lay.boundary.w, height: lay.boundary.h }}>
            <span className="c4-boundary-label">
              <strong>{focusName}</strong> [{focusEl ? KIND_LABEL[focusEl.kind] : 'Software system'}{focusEl?.technology ? `: ${focusEl.technology}` : ''}]
            </span>
          </div>
        )}
        <svg width={lay.width + pad * 2} height={lay.height + pad * 2} className="c4-edges" aria-hidden="true">
          <defs>
            <marker id="c4-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" style={{ fill: 'var(--edge)' }} />
            </marker>
          </defs>
          {lay.edges.map((e) => (
            <g key={e.id}>
              <polyline
                points={e.points.map(([x, y]) => `${x + pad},${y + pad}`).join(' ')}
                style={{ fill: 'none', stroke: 'var(--edge)', strokeWidth: 1.5, strokeDasharray: e.async ? '6 4' : undefined }}
                markerEnd="url(#c4-arrow)"
              />
              {e.labels.map((l, i) => (
                <text key={i} x={l.x + pad} y={l.y + pad + 11} className="c4-edge-label">
                  <title>{l.full}</title>
                  <tspan>{l.text}</tspan>
                  {l.tech && <tspan x={l.x + pad} dy="14" className="c4-edge-tech">[{l.tech}]</tspan>}
                </text>
              ))}
            </g>
          ))}
        </svg>
        {lay.nodes.map((n) => (
          <button
            key={n.el.id}
            className={`c4-node ${shapeClass(n.el.kind)}${n.out || n.el.kind === 'external' ? ' c4-out' : ''}${selected === n.el.id ? ' c4-sel' : ''}`}
            style={{ left: n.x + pad, top: n.y + pad, width: NODE_W, height: NODE_H }}
            onClick={() => (n.drill && !n.out ? onDrill(n.el.id) : onSelect(n.el.id))}
            onFocus={() => onSelect(n.el.id)}
            title={n.drill && !n.out ? `Open ${n.el.name} (${n.drill} components)` : n.el.name}
          >
            <span className="c4-name">{n.el.name}</span>
            <span className="c4-type mono">[{KIND_LABEL[n.el.kind]}{n.el.technology ? `: ${n.el.technology}` : ''}]</span>
            <span className="c4-desc">{n.el.description}</span>
            {n.drill > 0 && !n.out && <span className="c4-drill">Open {n.drill} ⤵</span>}
          </button>
        ))}
      </div>
      </div>
    </div>
  );
}

export function Legend() {
  return (
    <div className="c4-legend">
      <strong>Legend</strong>
      <span><i className="lg c4-person" />Person</span>
      <span><i className="lg c4-box" />Container / component</span>
      <span><i className="lg c4-store" />Data store</span>
      <span><i className="lg c4-queue" />Queue</span>
      <span><i className="lg c4-box c4-out" />External / out of focus</span>
      <span><svg width="26" height="8" aria-hidden="true"><path d="M0 4H26" style={{ stroke: 'var(--edge)', strokeWidth: 1.5 }} /></svg>Sync</span>
      <span><svg width="26" height="8" aria-hidden="true"><path d="M0 4H26" style={{ stroke: 'var(--edge)', strokeWidth: 1.5, strokeDasharray: '5 4' }} /></svg>Async</span>
      <span><b style={{ color: 'var(--accent)' }}>⤵</b> Click to open its components</span>
    </div>
  );
}
