import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OFFLINE_MS, RECENT_AGENT_MS, SessionStates, type StatusEntry } from './session-state.js';

const T = 1_000_000_000;
const entry = (agent: string, verb: string, at: number): StatusEntry => ({
  agent,
  verb,
  detail: '',
  task_id: null,
  at,
});

describe('SessionStates', () => {
  it('is offline with no entries', () => {
    const v = new SessionStates().view('p', T);
    assert.deepEqual(v, { state: 'offline', main: null, agents: [] });
  });

  it('is offline when main is stale and no agent is live', () => {
    const s = new SessionStates();
    s.record('p', entry('orchestrator', 'Edit', T - OFFLINE_MS - 1));
    s.record('p', entry('builder', 'Bash', T - OFFLINE_MS - 5));
    const v = s.view('p', T);
    assert.equal(v.state, 'offline');
    assert.equal(v.main?.verb, 'Edit');
    assert.deepEqual(v.agents, []);
  });

  it('is working when main is active', () => {
    const s = new SessionStates();
    s.record('p', entry('orchestrator', 'Edit', T - 1000));
    assert.equal(s.view('p', T).state, 'working');
  });

  it('is working when main is stale but a subagent is live', () => {
    const s = new SessionStates();
    s.record('p', entry('orchestrator', 'Edit', T - OFFLINE_MS - 1));
    s.record('p', entry('builder', 'Bash', T - 1000));
    assert.equal(s.view('p', T).state, 'working');
  });

  it('is idle when main is idle and no subagent is recent', () => {
    const s = new SessionStates();
    s.record('p', entry('orchestrator', 'idle', T - 1000));
    s.record('p', entry('builder', 'Bash', T - RECENT_AGENT_MS - 1));
    const v = s.view('p', T);
    assert.equal(v.state, 'idle');
    assert.equal(v.agents.length, 1); // still listed: newer than OFFLINE_MS
  });

  it('is working when main is idle but a subagent is recent', () => {
    const s = new SessionStates();
    s.record('p', entry('orchestrator', 'idle', T - 1000));
    s.record('p', entry('builder', 'Bash', T - RECENT_AGENT_MS + 1));
    assert.equal(s.view('p', T).state, 'working');
  });

  it('is needs_you when main says so', () => {
    const s = new SessionStates();
    s.record('p', entry('orchestrator', 'needs you', T - 1000));
    s.record('p', entry('builder', 'Bash', T - 10));
    assert.equal(s.view('p', T).state, 'needs_you');
  });

  it('keeps the latest entry per agent, filters stale ones, newest first', () => {
    const s = new SessionStates();
    s.record('p', entry('a', 'Read', T - 5000));
    s.record('p', entry('a', 'Edit', T - 100)); // replaces the earlier 'a'
    s.record('p', entry('b', 'Bash', T - 2000));
    s.record('p', entry('c', 'Grep', T - OFFLINE_MS - 1)); // stale
    s.record('other', entry('d', 'Bash', T));
    const v = s.view('p', T);
    assert.deepEqual(
      v.agents.map((a) => [a.agent, a.verb]),
      [
        ['a', 'Edit'],
        ['b', 'Bash'],
      ],
    );
    assert.equal(v.main, null);
    assert.equal(v.state, 'working');
  });

  it('forget drops a project', () => {
    const s = new SessionStates();
    s.record('p', entry('orchestrator', 'Edit', T));
    s.record('q', entry('orchestrator', 'Edit', T));
    s.forget('p');
    assert.equal(s.view('p', T).state, 'offline');
    assert.equal(s.view('p', T).main, null);
    assert.equal(s.view('q', T).state, 'working');
  });
});
