import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { LocalHTTPTransport, signDelivery, signedString } from './transport.js';

describe('signDelivery', () => {
  it('produces a stable, pinned sha256 for a known body+secret+timestamp', () => {
    const body = '{"hello":"world"}';
    const secret = 'topsecret';
    const ts = '1720000000';
    // Expected computed independently below (not via signDelivery) to pin the value.
    const expectedHex = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    assert.equal(signDelivery(body, secret, ts), `sha256=${expectedHex}`);
    // Hard-pinned literal so a change in the signed-string construction is caught.
    assert.equal(
      signDelivery(body, secret, ts),
      'sha256=52d244ac1a6a2439a41606b15699f5254436a5b6d58c976e796dfa2f3f931dcd',
    );
  });

  it('signs the documented `${timestamp}.${body}` construction', () => {
    assert.equal(signedString('abc', '99'), '99.abc');
    const body = 'payload';
    const secret = 'k';
    const ts = 42;
    const expected = createHmac('sha256', secret).update(signedString(body, ts)).digest('hex');
    assert.equal(signDelivery(body, secret, ts), `sha256=${expected}`);
  });

  it('returns null for a null or empty secret', () => {
    assert.equal(signDelivery('body', null, '1'), null);
    assert.equal(signDelivery('body', '', '1'), null);
    assert.equal(signDelivery('body', undefined, '1'), null);
  });

  it('signs an empty body deterministically', () => {
    const secret = 'topsecret';
    const ts = '1720000000';
    const a = signDelivery('', secret, ts);
    const b = signDelivery('', secret, ts);
    assert.equal(a, b);
    assert.equal(a, 'sha256=f335ff513caf5cb43399e74a8979ed6cba5894c06bcf993267bf7987819cdf64');
  });

  it('yields different signatures for a different body, secret, or timestamp', () => {
    const base = signDelivery('body', 'secret', '1');
    assert.notEqual(base, signDelivery('BODY', 'secret', '1')); // body differs
    assert.notEqual(base, signDelivery('body', 'other', '1')); // secret differs
    assert.notEqual(base, signDelivery('body', 'secret', '2')); // timestamp differs
  });

  it('accepts a numeric timestamp identically to its string form', () => {
    assert.equal(signDelivery('body', 'secret', 1720000000), signDelivery('body', 'secret', '1720000000'));
  });
});

describe('LocalHTTPTransport', () => {
  let server: Server;
  let base: string;
  // Captured by the request handler so tests can assert what the target received.
  type Captured = { body: string; headers: IncomingMessage['headers']; url?: string };
  const captured: { value?: Captured } = {};
  // Read the capture back through a function so control-flow analysis can't
  // narrow it to `undefined` after `captured.value = undefined` resets.
  const lastCapture = (): Captured | undefined => captured.value;
  // The status code the next response should return; set per-test.
  let respondStatus = 200;

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        captured.value = { body: Buffer.concat(chunks).toString(), headers: req.headers, url: req.url };
        res.writeHead(respondStatus);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('POSTs the body and headers to the target and returns ok:true on 2xx', async () => {
    captured.value = undefined;
    respondStatus = 200;
    const t = new LocalHTTPTransport();
    const res = await t.send(base, { 'x-kankan-signature': 'sha256=abc' }, '{"a":1}');
    assert.deepEqual(res, { ok: true, status: 200 });
    assert.equal(lastCapture()?.body, '{"a":1}');
    assert.equal(lastCapture()?.headers['x-kankan-signature'], 'sha256=abc');
  });

  it('defaults content-type to application/json when the caller omits it', async () => {
    captured.value = undefined;
    respondStatus = 200;
    const t = new LocalHTTPTransport();
    await t.send(base, {}, 'body');
    assert.equal(lastCapture()?.headers['content-type'], 'application/json');
  });

  it('does not override a caller-supplied content-type (case-insensitive)', async () => {
    captured.value = undefined;
    respondStatus = 200;
    const t = new LocalHTTPTransport();
    await t.send(base, { 'Content-Type': 'text/plain' }, 'body');
    assert.equal(lastCapture()?.headers['content-type'], 'text/plain');
  });

  it('returns ok:false with the real status on a non-2xx response', async () => {
    captured.value = undefined;
    respondStatus = 500;
    const t = new LocalHTTPTransport();
    const res = await t.send(base, {}, 'body');
    assert.deepEqual(res, { ok: false, status: 500 });
  });

  it('returns ok:false status:0 with an error (never throws) for an unreachable target', async () => {
    // Port 1 on loopback: nothing is listening, so connect fails fast.
    const t = new LocalHTTPTransport();
    const res = await t.send('http://127.0.0.1:1', {}, 'body');
    assert.equal(res.ok, false);
    assert.equal(res.status, 0);
    assert.equal(typeof res.error, 'string');
  });

  it('does NOT follow redirects (redirect:manual) — a 302 yields a non-ok 3xx result', async () => {
    // A server that 302-redirects to the metadata endpoint. With redirect:'manual'
    // the transport surfaces the 3xx itself (ok:false) and never chases the Location.
    const redirector = createServer((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    const { port } = redirector.address() as AddressInfo;
    try {
      const t = new LocalHTTPTransport();
      const res = await t.send(`http://127.0.0.1:${port}`, {}, 'body');
      assert.equal(res.ok, false); // a 3xx is not ok
      assert.ok(res.status >= 300 && res.status < 400, `expected a 3xx, got ${res.status}`);
    } finally {
      await new Promise<void>((resolve) => redirector.close(() => resolve()));
    }
  });

  it('returns ok:false status:0 (never throws) when the target hangs past the timeout', async () => {
    const hang = createServer((_req, _res) => {
      // Deliberately never respond — force the AbortController timeout to fire.
    });
    await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', resolve));
    const { port } = hang.address() as AddressInfo;
    try {
      const t = new LocalHTTPTransport(50); // 50ms timeout
      const res = await t.send(`http://127.0.0.1:${port}`, {}, 'body');
      assert.equal(res.ok, false);
      assert.equal(res.status, 0);
      assert.equal(typeof res.error, 'string');
    } finally {
      hang.closeAllConnections?.();
      await new Promise<void>((resolve) => hang.close(() => resolve()));
    }
  });
});
