import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { assertSafeTarget } from './target-safety.js';

/**
 * Run `fn` with KANKAN_STRICT_TARGETS forced on, restoring the prior value
 * afterward so tests don't leak the flag into each other.
 */
function withStrict(fn: () => void): void {
  const prev = process.env.KANKAN_STRICT_TARGETS;
  process.env.KANKAN_STRICT_TARGETS = '1';
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.KANKAN_STRICT_TARGETS;
    else process.env.KANKAN_STRICT_TARGETS = prev;
  }
}

describe('assertSafeTarget — always-block rules (both modes)', () => {
  // Ensure strict is OFF for the default-mode assertions in this block.
  afterEach(() => {
    delete process.env.KANKAN_STRICT_TARGETS;
  });

  const metadataTargets = [
    'http://169.254.169.254/latest/meta-data/',
    'https://metadata.google.internal/computeMetadata/v1/',
    'http://100.100.100.200/latest/meta-data/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    // scheme-prefixed metadata target — the connector scheme is stripped first
    'slack:http://169.254.169.254/latest/meta-data/',
  ];

  it('blocks cloud-metadata hosts with strict mode OFF', () => {
    for (const t of metadataTargets) {
      assert.throws(() => assertSafeTarget(t), /metadata/i, `expected block: ${t}`);
    }
  });

  it('blocks cloud-metadata hosts with strict mode ON', () => {
    withStrict(() => {
      for (const t of metadataTargets) {
        assert.throws(() => assertSafeTarget(t), /metadata/i, `expected block: ${t}`);
      }
    });
  });

  it('rejects non-http(s) schemes (file:, gopher:, ftp:, data:)', () => {
    for (const t of [
      'file:///etc/passwd',
      'gopher://127.0.0.1:6379/_INFO',
      'ftp://example.com/x',
      'data:text/plain,hello',
    ]) {
      assert.throws(() => assertSafeTarget(t), /http\/https|not allowed/i, `expected reject: ${t}`);
    }
  });

  it('rejects a target that is not a parseable URL', () => {
    assert.throws(() => assertSafeTarget('x'), /cannot parse/i);
    assert.throws(() => assertSafeTarget('not a url'), /cannot parse/i);
  });

  it('accepts a normal public https target (plain and scheme-prefixed)', () => {
    assert.doesNotThrow(() => assertSafeTarget('https://hooks.slack.com/services/T/B/xxx'));
    assert.doesNotThrow(() => assertSafeTarget('slack:https://hooks.slack.com/services/T/B/xxx'));
    withStrict(() => {
      assert.doesNotThrow(() => assertSafeTarget('https://hooks.slack.com/services/T/B/xxx'));
      assert.doesNotThrow(() => assertSafeTarget('slack:https://hooks.slack.com/services/T/B/xxx'));
    });
  });
});

describe('assertSafeTarget — strict mode OFF (default): loopback/private allowed (protects the demo)', () => {
  afterEach(() => {
    delete process.env.KANKAN_STRICT_TARGETS;
  });

  it('allows a loopback target (plain and slack:-prefixed)', () => {
    assert.doesNotThrow(() => assertSafeTarget('http://127.0.0.1:3000/x'));
    assert.doesNotThrow(() => assertSafeTarget('slack:http://127.0.0.1:3000/x'));
  });

  it('allows an RFC1918 private target', () => {
    assert.doesNotThrow(() => assertSafeTarget('http://10.1.2.3/hook'));
    assert.doesNotThrow(() => assertSafeTarget('http://192.168.1.50:8080/hook'));
    assert.doesNotThrow(() => assertSafeTarget('http://172.16.0.9/hook'));
  });

  it('allows localhost by name', () => {
    assert.doesNotThrow(() => assertSafeTarget('http://localhost:4000/x'));
  });
});

describe('assertSafeTarget — strict mode ON (KANKAN_STRICT_TARGETS=1): block internal ranges', () => {
  it('blocks loopback (127.0.0.0/8, ::1, localhost)', () => {
    withStrict(() => {
      assert.throws(() => assertSafeTarget('http://127.0.0.1:3000/x'), /strict/i);
      assert.throws(() => assertSafeTarget('slack:http://127.0.0.1:3000/x'), /strict/i);
      assert.throws(() => assertSafeTarget('http://[::1]:3000/x'), /strict/i);
      assert.throws(() => assertSafeTarget('http://localhost:4000/x'), /strict/i);
    });
  });

  it('blocks RFC1918 private ranges (10/8, 172.16/12, 192.168/16)', () => {
    withStrict(() => {
      assert.throws(() => assertSafeTarget('http://10.1.2.3/x'), /strict/i);
      assert.throws(() => assertSafeTarget('http://172.16.0.9/x'), /strict/i);
      assert.throws(() => assertSafeTarget('http://172.31.255.255/x'), /strict/i);
      assert.throws(() => assertSafeTarget('http://192.168.1.50:8080/x'), /strict/i);
      // 172.15 and 172.32 are OUTSIDE the /12 → allowed even in strict mode
      assert.doesNotThrow(() => assertSafeTarget('http://172.15.0.1/x'));
      assert.doesNotThrow(() => assertSafeTarget('http://172.32.0.1/x'));
    });
  });

  it('blocks link-local (169.254.0.0/16, fe80::/10)', () => {
    withStrict(() => {
      assert.throws(() => assertSafeTarget('http://169.254.10.20/x'), /strict/i);
      assert.throws(() => assertSafeTarget('http://[fe80::1]/x'), /strict/i);
    });
  });

  it('still passes a normal public https target', () => {
    withStrict(() => {
      assert.doesNotThrow(() => assertSafeTarget('https://hooks.slack.com/services/T/B/xxx'));
      assert.doesNotThrow(() => assertSafeTarget('https://example.com/hook'));
    });
  });
});
