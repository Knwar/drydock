import type { PlanBoard, PlanContext, PlanData, PlanEdge, PlanIssue, PlanNode, PlanValidation } from './types.js';

// ── pure graph logic over a plan draft (no DB access) ──
//
// Edges mean `to` depends on `from`. Functions ignore edges whose endpoints
// aren't in `nodes`; validatePlan reports those separately.

type NodeRef = Pick<PlanNode, 'id'>;

/** Distinct node ids in node order (first occurrence wins). */
function ids(nodes: NodeRef[]): string[] {
  return [...new Set(nodes.map((n) => n.id))];
}

/** Successor lists over known nodes, deduped, in edge order. */
function adjacency(nodeIds: string[], edges: PlanEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const { from, to } of edges) {
    const out = adj.get(from);
    if (!out || !adj.has(to) || out.includes(to)) continue;
    out.push(to);
  }
  return adj;
}

/** A node-id array forming a cycle (in edge direction), or null when acyclic. */
export function findCycle(nodes: NodeRef[], edges: PlanEdge[]): string[] | null {
  const nodeIds = ids(nodes);
  const adj = adjacency(nodeIds, edges);
  const state = new Map<string, 1 | 2>(); // 1 = on the DFS stack, 2 = finished
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const next of adj.get(id)!) {
      const s = state.get(next);
      if (s === 1) return stack.slice(stack.indexOf(next));
      if (s === undefined) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of nodeIds) {
    if (state.has(id)) continue;
    const found = visit(id);
    if (found) return found;
  }
  return null;
}

/** Topological order (Kahn, stable by node order), or null on a cycle. */
function topoOrder(nodeIds: string[], adj: Map<string, string[]>): string[] | null {
  const indeg = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  for (const outs of adj.values()) for (const to of outs) indeg.set(to, indeg.get(to)! + 1);
  const order: string[] = [];
  const ready = nodeIds.filter((id) => indeg.get(id) === 0);
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const to of adj.get(id)!) {
      indeg.set(to, indeg.get(to)! - 1);
      if (indeg.get(to) === 0) ready.push(to);
    }
  }
  return order.length === nodeIds.length ? order : null;
}

/**
 * Column per node = longest dependency distance from a source (0-based), so every
 * node in a column can be built at once. Null when the graph has a cycle.
 */
export function layoutColumns(nodes: NodeRef[], edges: PlanEdge[]): Record<string, number> | null {
  const nodeIds = ids(nodes);
  const adj = adjacency(nodeIds, edges);
  const order = topoOrder(nodeIds, adj);
  if (!order) return null;
  const col: Record<string, number> = Object.fromEntries(nodeIds.map((id) => [id, 0]));
  for (const id of order) for (const to of adj.get(id)!) col[to] = Math.max(col[to], col[id] + 1);
  return col;
}

/**
 * Node ids along one longest dependency path (by node count). Ties go to the
 * node earliest in `nodes` order. Empty when there are no nodes or a cycle.
 */
export function longestChain(nodes: NodeRef[], edges: PlanEdge[]): string[] {
  const nodeIds = ids(nodes);
  const adj = adjacency(nodeIds, edges);
  const order = topoOrder(nodeIds, adj);
  if (!order || !order.length) return [];
  const rank = new Map(nodeIds.map((id, i) => [id, i]));
  const len = new Map<string, number>(nodeIds.map((id) => [id, 1]));
  const prev = new Map<string, string>();
  for (const id of order) {
    for (const to of adj.get(id)!) {
      const cand = len.get(id)! + 1;
      const cur = prev.get(to);
      if (cand > len.get(to)! || (cand === len.get(to)! && cur !== undefined && rank.get(id)! < rank.get(cur)!)) {
        len.set(to, cand);
        prev.set(to, id);
      }
    }
  }
  let end = nodeIds[0];
  for (const id of nodeIds) if (len.get(id)! > len.get(end)!) end = id;
  const chain = [end];
  for (let p = prev.get(end); p !== undefined; p = prev.get(p)) chain.unshift(p);
  return chain;
}

/** Is `to` reachable from `from` along edges (a path of 1+ edges)? */
function reaches(from: string, to: string, edges: PlanEdge[]): boolean {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of edges) {
      if (e.from !== id) continue;
      if (e.to === to) return true;
      if (!seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return false;
}

/** True when neither node is reachable from the other (and they are distinct). */
export function canRunInParallel(a: string, b: string, edges: PlanEdge[]): boolean {
  return a !== b && !reaches(a, b, edges) && !reaches(b, a, edges);
}

// ── phase order ──

type PhasedNode = Pick<PlanNode, 'id' | 'board_id' | 'phase'>;
const phaseName = (n: PhasedNode): string | null => n.phase?.trim() || null;

/**
 * Phase-level dependencies on one board: phase → the phases it must follow. A
 * phase X depends on Y when a node of X on `boardId` (transitively, through any
 * board) depends on a node of Y on `boardId`.
 */
export function phaseDependencies(nodes: PhasedNode[], edges: PlanEdge[], boardId: string): Map<string, Set<string>> {
  const adj = adjacency(ids(nodes), edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const deps = new Map<string, Set<string>>();
  for (const n of nodes) {
    const from = phaseName(n);
    if (n.board_id !== boardId || !from) continue;
    const seen = new Set<string>();
    const stack = [...adj.get(n.id)!];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...adj.get(id)!);
      const m = byId.get(id)!;
      const to = phaseName(m);
      if (m.board_id !== boardId || !to || to === from) continue;
      if (!deps.has(to)) deps.set(to, new Set());
      deps.get(to)!.add(from);
    }
  }
  return deps;
}

/**
 * `names` ordered so each phase follows the phases it depends on (deps outside
 * `names` are ignored); ties keep `names` order. Null on a cycle.
 */
export function orderPhases(names: string[], deps: Map<string, Set<string>>): string[] | null {
  const rest = [...names];
  const order: string[] = [];
  while (rest.length) {
    const i = rest.findIndex((x) => ![...(deps.get(x) ?? [])].some((d) => d !== x && rest.includes(d)));
    if (i < 0) return null;
    order.push(...rest.splice(i, 1));
  }
  return order;
}

/** The phases (in edge direction) of one board's phase-level dependency cycle, or null. */
export function phaseCycle(nodes: PhasedNode[], edges: PlanEdge[], boardId: string): string[] | null {
  const names = [...new Set(nodes.filter((n) => n.board_id === boardId).map(phaseName).filter((x): x is string => !!x))];
  const deps = phaseDependencies(nodes, edges, boardId);
  const phaseEdges = [...deps].flatMap(([to, froms]) => [...froms].map((from) => ({ from, to })));
  return findCycle(names.map((id) => ({ id })), phaseEdges);
}

// ── path overlap helpers (touches) ──

const GLOB_CHARS = /[*?[\]{}]/;

function normPath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** The glob-free prefix of a path ('' for a pure glob like `**` /`*.ts`), and whether it was a glob. */
function base(p: string): { base: string; glob: boolean } {
  const n = normPath(p);
  const i = n.search(GLOB_CHARS);
  return i < 0 ? { base: n, glob: false } : { base: n.slice(0, i), glob: true };
}

/** Is `path` equal to or inside directory/file `dir` (segment-aware)? '' contains everything. */
function under(path: string, dir: string): boolean {
  return dir === '' || path === dir || path.startsWith(dir + '/');
}

/** `dir/prefix*suffix` with one `*` in the final segment and no other glob chars, split up; else null. */
function singleStar(p: string): { dir: string; prefix: string; suffix: string } | null {
  const m = /^(?:(.*)\/)?([^/]*)$/.exec(normPath(p))!;
  const [dir = '', seg] = [m[1], m[2]];
  if (GLOB_CHARS.test(dir)) return null;
  const star = seg.indexOf('*');
  if (star < 0 || seg.indexOf('*', star + 1) >= 0 || GLOB_CHARS.test(seg.replace('*', ''))) return null;
  return { dir, prefix: seg.slice(0, star), suffix: seg.slice(star + 1) };
}

/** Do two touched paths/globs overlap? Identical path, or one's glob-free prefix covers the other. */
function overlaps(a: string, b: string): boolean {
  const A = base(a);
  const B = base(b);
  if (!A.glob && !B.glob) return under(A.base, B.base) || under(B.base, A.base);
  // glob vs plain: the glob's prefix covers the path, or the path is a directory at/above the glob's prefix
  const globPlain = (g: string, p: string) => p.startsWith(g) || under(g.replace(/\/+$/, ''), p);
  if (A.glob && !B.glob) return globPlain(A.base, B.base);
  if (!A.glob && B.glob) return globPlain(B.base, A.base);
  // two single-`*` globs in a final segment match only in the same folder with compatible prefix/suffix
  const sa = singleStar(a);
  const sb = singleStar(b);
  if (sa && sb) {
    const compat = (x: string, y: string, f: 'startsWith' | 'endsWith') => x[f](y) || y[f](x);
    return sa.dir === sb.dir && compat(sa.prefix, sb.prefix, 'startsWith') && compat(sa.suffix, sb.suffix, 'endsWith');
  }
  return A.base.startsWith(B.base) || B.base.startsWith(A.base);
}

/** The verticals a touched path falls under: the deepest root containing it, else the roots it spans. */
function ownersOf(path: string, verticals: PlanBoard[]): PlanBoard[] {
  const { base: b, glob } = base(path);
  const containing = verticals.filter((v) => under(b, normPath(v.root)));
  if (containing.length) {
    return [containing.reduce((x, y) => (normPath(y.root).length > normPath(x.root).length ? y : x))];
  }
  // A path/glob above vertical roots spans every vertical beneath it.
  return verticals.filter((v) => {
    const r = normPath(v.root);
    return glob ? r.startsWith(b) : under(r, b);
  });
}

// ── validation ──

/** Commit-blocking errors and informational warnings for a draft. */
export function validatePlan(data: Pick<PlanData, 'nodes' | 'edges'>, ctx: PlanContext): PlanValidation {
  const errors: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];
  const { nodes, edges } = data;

  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const n of nodes) (seen.has(n.id) ? dupes : seen).add(n.id);
  for (const id of dupes)
    errors.push({ code: 'duplicate_node_id', message: `node id "${id}" is used more than once`, nodes: [id] });

  for (const n of nodes) {
    if (!n.title || !n.title.trim())
      errors.push({ code: 'empty_title', message: `node "${n.id}" has an empty title`, nodes: [n.id] });
  }

  const boards = new Map(ctx.boards.map((b) => [b.id, b]));
  for (const n of nodes) {
    if (!boards.has(n.board_id))
      errors.push({
        code: 'unknown_board',
        message: `node "${n.id}" targets board "${n.board_id}", which is not in this workspace`,
        nodes: [n.id],
      });
  }

  const edgeKeys = new Set<string>();
  for (const e of edges) {
    const key = `${e.from}\u0000${e.to}`;
    if (!seen.has(e.from) || !seen.has(e.to)) {
      const missing = [e.from, e.to].filter((id) => !seen.has(id));
      errors.push({
        code: 'unknown_node',
        message: `edge ${e.from} -> ${e.to} references unknown node ${missing.map((m) => `"${m}"`).join(', ')}`,
        edges: [{ from: e.from, to: e.to }],
      });
    } else if (e.from === e.to) {
      errors.push({
        code: 'self_loop',
        message: `node "${e.from}" depends on itself`,
        nodes: [e.from],
        edges: [{ from: e.from, to: e.to }],
      });
    } else if (edgeKeys.has(key)) {
      errors.push({
        code: 'duplicate_edge',
        message: `edge ${e.from} -> ${e.to} appears more than once`,
        edges: [{ from: e.from, to: e.to }],
      });
    }
    edgeKeys.add(key);
  }

  // Self-loops are already reported; look for longer cycles only.
  const cycle = findCycle(nodes, edges.filter((e) => e.from !== e.to));
  if (cycle)
    errors.push({
      code: 'cycle',
      message: `dependency cycle: ${[...cycle, cycle[0]].join(' -> ')}`,
      nodes: cycle,
    });

  // Warnings consider each node id once (first occurrence).
  const unique = nodes.filter((n, i) => nodes.findIndex((m) => m.id === n.id) === i);

  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const a = unique[i];
      const b = unique[j];
      if (!a.touches?.length || !b.touches?.length) continue;
      const shared = a.touches.filter((p) => b.touches!.some((q) => overlaps(p, q)));
      if (!shared.length || !canRunInParallel(a.id, b.id, edges)) continue;
      warnings.push({
        code: 'shared_file',
        message: `"${a.title}" and "${b.title}" can run in parallel but both touch ${shared.join(', ')}: sequence them`,
        nodes: [a.id, b.id],
      });
    }
  }

  const verticals = ctx.boards.filter((b) => normPath(b.root) !== '');
  for (const n of unique) {
    const board = boards.get(n.board_id);
    if (!board || normPath(board.root) === '' || !n.touches?.length) continue;
    const owners = new Map<string, PlanBoard>();
    for (const p of n.touches) for (const v of ownersOf(p, verticals)) owners.set(v.id, v);
    const foreign = [...owners.values()].filter((v) => v.id !== board.id);
    if (!foreign.length) continue;
    const names = [...owners.values()].map((v) => v.name).join(', ');
    warnings.push({
      code: 'cross_vertical',
      message:
        owners.size > 1
          ? `"${n.title}" touches ${owners.size} verticals (${names}): it belongs on the workspace board`
          : `"${n.title}" is on ${board.name} but touches ${names}: it belongs on the workspace board`,
      nodes: [n.id],
    });
  }

  for (const boardId of [...new Set(unique.map((n) => n.board_id))]) {
    const cycle = phaseCycle(unique, edges, boardId);
    if (!cycle) continue;
    const board = boards.get(boardId)?.name ?? boardId;
    warnings.push({
      code: 'phase_order',
      message: `phases ${cycle.map((p) => `"${p}"`).join(', ')} on ${board} depend on each other: new phases keep their plan order`,
      nodes: unique.filter((n) => n.board_id === boardId && cycle.includes(n.phase?.trim() ?? '')).map((n) => n.id),
    });
  }

  for (const n of unique) {
    const noReq = !n.requirements || !n.requirements.trim();
    const noSubs = !n.subtasks || !n.subtasks.length;
    if (noReq || noSubs)
      warnings.push({
        code: 'missing_spec',
        message: `"${n.title}" has no ${noReq && noSubs ? 'requirements or subtasks' : noReq ? 'requirements' : 'subtasks'}: Run won't queue it`,
        nodes: [n.id],
      });
  }

  return { errors, warnings };
}
