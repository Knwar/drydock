import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canRunInParallel,
  findCycle,
  layoutColumns,
  longestChain,
  orderPhases,
  phaseDependencies,
  validatePlan,
} from './plan-graph.js';
import type { PlanContext, PlanEdge, PlanNode } from './types.js';

const ns = (...ids: string[]) => ids.map((id) => ({ id }));
const es = (...pairs: string[]): PlanEdge[] =>
  pairs.map((p) => {
    const [from, to] = p.split('>');
    return { from, to };
  });

// a -> b, a -> c, b -> d, c -> d
const DIAMOND = { nodes: ns('a', 'b', 'c', 'd'), edges: es('a>b', 'a>c', 'b>d', 'c>d') };
const CHAIN = { nodes: ns('a', 'b', 'c'), edges: es('a>b', 'b>c') };

describe('plan graph', () => {
  it('diamond: columns, longest chain, parallel', () => {
    assert.equal(findCycle(DIAMOND.nodes, DIAMOND.edges), null);
    assert.deepEqual(layoutColumns(DIAMOND.nodes, DIAMOND.edges), { a: 0, b: 1, c: 1, d: 2 });
    assert.deepEqual(longestChain(DIAMOND.nodes, DIAMOND.edges), ['a', 'b', 'd']); // tie b/c -> b (node order)
    assert.equal(canRunInParallel('b', 'c', DIAMOND.edges), true);
    assert.equal(canRunInParallel('a', 'd', DIAMOND.edges), false);
    assert.equal(canRunInParallel('d', 'b', DIAMOND.edges), false);
  });

  it('chain', () => {
    assert.deepEqual(layoutColumns(CHAIN.nodes, CHAIN.edges), { a: 0, b: 1, c: 2 });
    assert.deepEqual(longestChain(CHAIN.nodes, CHAIN.edges), ['a', 'b', 'c']);
    assert.equal(canRunInParallel('a', 'c', CHAIN.edges), false);
    assert.equal(canRunInParallel('a', 'a', CHAIN.edges), false);
  });

  it('column is the LONGEST distance from a source', () => {
    // a -> b -> c, a -> c: c must sit after b
    assert.deepEqual(layoutColumns(ns('a', 'b', 'c'), es('a>b', 'b>c', 'a>c')), { a: 0, b: 1, c: 2 });
  });

  it('disconnected nodes', () => {
    const nodes = ns('x', 'y', 'z');
    const edges = es('y>z');
    assert.deepEqual(layoutColumns(nodes, edges), { x: 0, y: 0, z: 1 });
    assert.deepEqual(longestChain(nodes, edges), ['y', 'z']);
    assert.equal(canRunInParallel('x', 'z', edges), true);
    assert.deepEqual(longestChain(ns('p', 'q'), []), ['p']); // tie -> first node
    assert.deepEqual(longestChain([], []), []);
  });

  it('detects a cycle with its members; layout is null', () => {
    const nodes = ns('s', 'a', 'b', 'c');
    const edges = es('s>a', 'a>b', 'b>c', 'c>a');
    const cycle = findCycle(nodes, edges);
    assert.deepEqual(new Set(cycle), new Set(['a', 'b', 'c']));
    assert.equal(cycle!.length, 3);
    assert.equal(layoutColumns(nodes, edges), null);
    assert.deepEqual(longestChain(nodes, edges), []);
    assert.deepEqual(findCycle(ns('a'), es('a>a')), ['a']);
  });

  it('ignores edges to unknown nodes', () => {
    assert.deepEqual(layoutColumns(ns('a'), es('a>ghost')), { a: 0 });
  });
});

const WS = 'ws';
const CTX: PlanContext = {
  boards: [
    { id: WS, name: 'Shop', root: '' },
    { id: 'web', name: 'Web', root: 'apps/web' },
    { id: 'mob', name: 'Mobile', root: 'apps/mobile' },
  ],
};
const node = (id: string, extra: Partial<PlanNode> = {}): PlanNode => ({
  id,
  title: `T ${id}`,
  board_id: WS,
  requirements: 'spec',
  subtasks: ['do it'],
  ...extra,
});
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('validatePlan', () => {
  it('a clean plan has no issues', () => {
    const v = validatePlan({ nodes: [node('a'), node('b')], edges: es('a>b') }, CTX);
    assert.deepEqual(v, { errors: [], warnings: [], groups: [] });
  });

  it('empty title', () => {
    const v = validatePlan({ nodes: [node('a', { title: '  ' })], edges: [] }, CTX);
    assert.deepEqual(codes(v.errors), ['empty_title']);
    assert.deepEqual(v.errors[0].nodes, ['a']);
  });

  it('duplicate node id', () => {
    const v = validatePlan({ nodes: [node('a'), node('a')], edges: [] }, CTX);
    assert.deepEqual(codes(v.errors), ['duplicate_node_id']);
  });

  it('edge to an unknown node', () => {
    const v = validatePlan({ nodes: [node('a')], edges: es('a>ghost') }, CTX);
    assert.deepEqual(codes(v.errors), ['unknown_node']);
    assert.deepEqual(v.errors[0].edges, [{ from: 'a', to: 'ghost' }]);
  });

  it('self-loop (not also reported as a cycle)', () => {
    const v = validatePlan({ nodes: [node('a')], edges: es('a>a') }, CTX);
    assert.deepEqual(codes(v.errors), ['self_loop']);
  });

  it('duplicate edge', () => {
    const v = validatePlan({ nodes: [node('a'), node('b')], edges: es('a>b', 'a>b') }, CTX);
    assert.deepEqual(codes(v.errors), ['duplicate_edge']);
  });

  it('cycle lists its nodes', () => {
    const v = validatePlan({ nodes: [node('a'), node('b'), node('c')], edges: es('a>b', 'b>c', 'c>a') }, CTX);
    assert.deepEqual(codes(v.errors), ['cycle']);
    assert.deepEqual(new Set(v.errors[0].nodes), new Set(['a', 'b', 'c']));
  });

  it('unknown board', () => {
    const v = validatePlan({ nodes: [node('a', { board_id: 'elsewhere' })], edges: [] }, CTX);
    assert.deepEqual(codes(v.errors), ['unknown_board']);
  });

  describe('shared_file', () => {
    it('warns when parallel nodes touch the same path', () => {
      const v = validatePlan(
        { nodes: [node('a', { touches: ['package.json'] }), node('b', { touches: ['./package.json'] })], edges: [] },
        CTX,
      );
      assert.deepEqual(codes(v.warnings), ['shared_file']);
      assert.deepEqual(v.warnings[0].nodes, ['a', 'b']);
      assert.match(v.warnings[0].message, /sequence them/);
    });

    it('warns on an overlapping glob-free prefix', () => {
      const v = validatePlan(
        { nodes: [node('a', { touches: ['src/core/**'] }), node('b', { touches: ['src/core/db.ts'] })], edges: [] },
        CTX,
      );
      assert.deepEqual(codes(v.warnings), ['shared_file']);
    });

    it('a glob overlaps its own plain directory (and a parent directory)', () => {
      for (const dir of ['src/core', 'src/core/', 'src']) {
        const v = validatePlan(
          { nodes: [node('a', { touches: ['src/core/**'] }), node('b', { touches: [dir] })], edges: [] },
          CTX,
        );
        assert.deepEqual(codes(v.warnings), ['shared_file'], dir);
      }
      const v = validatePlan(
        { nodes: [node('a', { touches: ['src/core/**'] }), node('b', { touches: ['src/cor'] })], edges: [] },
        CTX,
      );
      assert.deepEqual(v.warnings, []);
    });

    it('single-* globs in one folder overlap only when their literal parts are compatible', () => {
      const pair = (x: string, y: string) =>
        codes(validatePlan({ nodes: [node('a', { touches: [x] }), node('b', { touches: [y] })], edges: [] }, CTX).warnings);
      assert.deepEqual(pair('src/*.ts', 'src/*.css'), []);
      assert.deepEqual(pair('src/a*.ts', 'src/b*.ts'), []);
      assert.deepEqual(pair('src/*.ts', 'lib/*.ts'), []);
      assert.deepEqual(pair('src/*.ts', 'src/*.test.ts'), ['shared_file']);
      assert.deepEqual(pair('src/*.ts', 'src/plan*'), ['shared_file']);
      assert.deepEqual(pair('src/*.ts', 'src/**'), ['shared_file']);
    });

    it('no warning when the nodes are sequenced (even transitively)', () => {
      const v = validatePlan(
        {
          nodes: [node('a', { touches: ['package.json'] }), node('m'), node('b', { touches: ['package.json'] })],
          edges: es('a>m', 'm>b'),
        },
        CTX,
      );
      assert.deepEqual(v.warnings, []);
    });

    it('groups the pairs per path: one issue listing every card, per-pair warnings kept', () => {
      const t = (id: string, touches: string[]) => node(id, { title: id.toUpperCase(), touches });
      const v = validatePlan(
        {
          nodes: [
            t('a', ['src/server.ts']),
            t('b', ['src/server.ts', 'src/db.ts']),
            t('c', ['./src/server.ts']),
            t('d', ['src/db.ts']),
            t('e', ['src/server.ts']), // sequenced after a: still parallel with b and c
          ],
          edges: es('a>e'),
        },
        CTX,
      );
      assert.equal(v.warnings.filter((w) => w.code === 'shared_file').length, 6); // ab ac bc bd be ce
      assert.deepEqual(
        v.groups.map((g) => [g.code, g.nodes]),
        [
          ['shared_file_group', ['a', 'b', 'c', 'e']],
          ['shared_file_group', ['b', 'd']],
        ],
      );
      assert.equal(v.groups[0].message, '4 cards touch src/server.ts and some of them can run in parallel: sequence them');
      assert.equal(v.groups[1].message, '"B" and "D" can run in parallel but both touch src/db.ts: sequence them');
    });

    it('paths with the same cards share one group; no groups without shared files', () => {
      const v = validatePlan(
        { nodes: [node('a', { touches: ['x.ts', 'y.ts'] }), node('b', { touches: ['y.ts', 'x.ts'] })], edges: [] },
        CTX,
      );
      assert.equal(v.groups.length, 1);
      assert.match(v.groups[0].message, /both touch x\.ts, y\.ts: sequence them/);
      assert.deepEqual(validatePlan({ nodes: [node('a'), node('b')], edges: [] }, CTX).groups, []);
    });

    it('no warning for disjoint paths', () => {
      const v = validatePlan(
        { nodes: [node('a', { touches: ['src/a.ts'] }), node('b', { touches: ['src/ab.ts', 'src/core/*'] })], edges: [] },
        CTX,
      );
      assert.deepEqual(v.warnings, []);
    });
  });

  describe('cross_vertical', () => {
    it("warns for a vertical node touching another vertical's root", () => {
      const v = validatePlan({ nodes: [node('a', { board_id: 'web', touches: ['apps/mobile/app.tsx'] })], edges: [] }, CTX);
      assert.deepEqual(codes(v.warnings), ['cross_vertical']);
      assert.match(v.warnings[0].message, /workspace board/);
    });

    it('warns for a vertical node spanning 2+ verticals', () => {
      const v = validatePlan(
        { nodes: [node('a', { board_id: 'web', touches: ['apps/web/x.ts', 'apps/mobile/y.ts'] })], edges: [] },
        CTX,
      );
      assert.deepEqual(codes(v.warnings), ['cross_vertical']);
      const g = validatePlan({ nodes: [node('b', { board_id: 'web', touches: ['apps/**'] })], edges: [] }, CTX);
      assert.deepEqual(codes(g.warnings), ['cross_vertical']);
    });

    it('no warning for touches inside its own vertical, or on the workspace board', () => {
      const v = validatePlan(
        {
          nodes: [
            node('a', { board_id: 'web', touches: ['apps/web/src/**', 'apps/web/package.json'] }),
            node('b', { board_id: WS, touches: ['apps/web/x.ts', 'apps/mobile/y.ts'] }),
          ],
          edges: es('a>b'),
        },
        CTX,
      );
      assert.deepEqual(v.warnings, []);
      // 'apps/webby' is not under 'apps/web'
      const w = validatePlan({ nodes: [node('c', { board_id: 'mob', touches: ['apps/webby/x.ts'] })], edges: [] }, CTX);
      assert.deepEqual(w.warnings, []);
    });
  });

  it('missing_spec for no requirements or no subtasks', () => {
    const v = validatePlan(
      {
        nodes: [node('a', { requirements: undefined }), node('b', { subtasks: [] }), node('c')],
        edges: es('a>b', 'b>c'),
      },
      CTX,
    );
    assert.deepEqual(codes(v.warnings), ['missing_spec', 'missing_spec']);
    assert.deepEqual(
      v.warnings.map((w) => w.nodes),
      [['a'], ['b']],
    );
    assert.deepEqual(v.errors, []);
  });

  it('phase_order: phases on one board that depend on each other', () => {
    const nodes = [
      node('f1', { phase: 'Flow' }),
      node('r1', { phase: 'Reporting' }),
      node('f2', { phase: 'Flow' }),
      node('x', { board_id: 'web', phase: 'Flow' }),
    ];
    const ok = validatePlan({ nodes, edges: es('f1>r1') }, CTX);
    assert.deepEqual(ok.warnings, []);
    const v = validatePlan({ nodes, edges: es('f1>r1', 'r1>f2') }, CTX);
    assert.deepEqual(v.errors, [], 'a phase cycle is not a node cycle');
    assert.deepEqual(codes(v.warnings), ['phase_order']);
    assert.match(v.warnings[0].message, /"Flow", "Reporting" on Shop depend on each other/);
    assert.deepEqual(v.warnings[0].nodes, ['f1', 'r1', 'f2']);
  });
});

describe('phase order', () => {
  it('phase deps are transitive (through other boards) and per board', () => {
    const nodes: PlanNode[] = [
      node('r', { phase: 'Reporting' }),
      node('mid', { board_id: 'web' }),
      node('f', { phase: 'Flow' }),
      node('w', { board_id: 'web', phase: 'Flow' }),
    ];
    const deps = phaseDependencies(nodes, es('f>mid', 'mid>r'), WS);
    assert.deepEqual([...deps].map(([k, v]) => [k, [...v]]), [['Reporting', ['Flow']]]);
    assert.deepEqual(phaseDependencies(nodes, es('f>mid', 'mid>r'), 'web').size, 0);
  });

  it('orderPhases: dependencies first, ties in given order, null on a cycle', () => {
    const deps = new Map([['Reporting', new Set(['Flow'])]]);
    assert.deepEqual(orderPhases(['Reporting', 'Docs', 'Flow'], deps), ['Docs', 'Flow', 'Reporting']);
    assert.deepEqual(orderPhases(['Flow', 'Reporting'], deps), ['Flow', 'Reporting']);
    assert.deepEqual(orderPhases(['Reporting'], deps), ['Reporting'], 'deps outside the list are ignored');
    deps.set('Flow', new Set(['Reporting']));
    assert.equal(orderPhases(['Reporting', 'Flow'], deps), null);
  });
});
