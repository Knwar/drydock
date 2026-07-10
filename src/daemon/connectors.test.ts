import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONNECTORS,
  resolveConnector,
  slackConnector,
  signalConnector,
  type ConnectorEvent,
} from './connectors.js';

/** A representative 'block' event, mirroring what `raiseBlocker` writes. */
function blockEvent(overrides: Partial<ConnectorEvent> = {}): ConnectorEvent {
  return {
    id: 7,
    type: 'block',
    project_id: 'proj-1',
    task_id: '6da0ac85',
    payload: JSON.stringify({ reason: 'Missing SLACK_WEBHOOK secret' }),
    created_at: 1_720_000_000_000,
    ...overrides,
  };
}

describe('resolveConnector', () => {
  it('splits on the FIRST colon so an https endpoint is not mangled', () => {
    const target = 'slack:https://hooks.slack.com/services/T/B/xxx';
    const resolved = resolveConnector(target);
    assert.ok(resolved);
    assert.equal(resolved.connector, slackConnector);
    // The endpoint keeps every https:// colon intact.
    assert.equal(resolved.endpoint, 'https://hooks.slack.com/services/T/B/xxx');
  });

  it('resolves the signal scheme to the signal connector', () => {
    const resolved = resolveConnector('signal:https://signal.example/v2/send/+15551234567');
    assert.ok(resolved);
    assert.equal(resolved.connector, signalConnector);
    assert.equal(resolved.endpoint, 'https://signal.example/v2/send/+15551234567');
  });

  it('returns null for an unknown scheme', () => {
    assert.equal(resolveConnector('ftp://example.com/x'), null);
  });

  it('returns null for a target with no scheme', () => {
    assert.equal(resolveConnector('https://hooks.slack.com/services/T/B/xxx'), null);
    assert.equal(resolveConnector('no-colon-here'), null);
  });

  it('returns null for a leading-colon target (empty scheme)', () => {
    assert.equal(resolveConnector(':https://x'), null);
  });
});

describe('slackConnector.format', () => {
  it('builds a {"text":...} body citing the card and the parsed reason', () => {
    const { body, contentType } = slackConnector.format(blockEvent());
    assert.equal(contentType, 'application/json');
    const parsed = JSON.parse(body) as { text: string };
    assert.deepEqual(Object.keys(parsed), ['text']);
    assert.match(parsed.text, /6da0ac85/); // cites the card
    assert.match(parsed.text, /Missing SLACK_WEBHOOK secret/); // cites the reason
  });

  it('produces a sensible body when payload is null (no throw)', () => {
    const { body } = slackConnector.format(blockEvent({ payload: null }));
    const parsed = JSON.parse(body) as { text: string };
    assert.equal(typeof parsed.text, 'string');
    assert.ok(parsed.text.length > 0);
    assert.match(parsed.text, /6da0ac85/); // still cites the card
  });

  it('produces a sensible body when payload is malformed JSON (no throw)', () => {
    assert.doesNotThrow(() => slackConnector.format(blockEvent({ payload: '{not json' })));
    const { body } = slackConnector.format(blockEvent({ payload: '{not json' }));
    const parsed = JSON.parse(body) as { text: string };
    assert.equal(typeof parsed.text, 'string');
    assert.ok(parsed.text.length > 0);
  });

  it('produces a sensible body when payload has no reason field (no throw)', () => {
    const { body } = slackConnector.format(blockEvent({ payload: JSON.stringify({ other: 'x' }) }));
    const parsed = JSON.parse(body) as { text: string };
    assert.ok(parsed.text.length > 0);
  });

  it('handles a null task_id gracefully', () => {
    const { body } = slackConnector.format(blockEvent({ task_id: null }));
    const parsed = JSON.parse(body) as { text: string };
    assert.ok(parsed.text.length > 0);
  });
});

describe('signalConnector.format', () => {
  it('formats a JSON body carrying the message text', () => {
    const { body, contentType } = signalConnector.format(blockEvent());
    assert.equal(contentType, 'application/json');
    const parsed = JSON.parse(body) as { message: string };
    assert.equal(typeof parsed.message, 'string');
    assert.match(parsed.message, /6da0ac85/);
    assert.match(parsed.message, /Missing SLACK_WEBHOOK secret/);
  });

  it('does not throw on null / malformed payload', () => {
    assert.doesNotThrow(() => signalConnector.format(blockEvent({ payload: null })));
    assert.doesNotThrow(() => signalConnector.format(blockEvent({ payload: 'garbage' })));
  });
});

describe('parseTarget', () => {
  it('strips the scheme and returns the endpoint', () => {
    assert.equal(
      slackConnector.parseTarget('slack:https://hooks.slack.com/services/T/B/xxx'),
      'https://hooks.slack.com/services/T/B/xxx',
    );
    assert.equal(
      signalConnector.parseTarget('signal:https://signal.example/v2/send/+1555'),
      'https://signal.example/v2/send/+1555',
    );
  });
});

describe('CONNECTORS registry', () => {
  it('is keyed by scheme with slack and signal', () => {
    assert.equal(CONNECTORS.slack, slackConnector);
    assert.equal(CONNECTORS.signal, signalConnector);
    assert.deepEqual(Object.keys(CONNECTORS).sort(), ['signal', 'slack']);
  });
});
