import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { checkRequest, gatePolicy, hostName, type GateRequest } from './request-gate.js';

const policy = gatePolicy(7900, 5190);
const req = (r: Partial<GateRequest>): GateRequest => ({ method: 'GET', host: 'localhost:7900', origin: undefined, secFetchSite: undefined, contentType: undefined, hasBody: false, ...r });
const ok = (r: Partial<GateRequest>) => assert.equal(checkRequest(req(r), policy), null, JSON.stringify(r));
const refused = (r: Partial<GateRequest>, why: RegExp) => assert.match(checkRequest(req(r), policy) ?? 'allowed', why, JSON.stringify(r));

describe('request gate', () => {
  it('lets Drydock’s own app through, from the daemon and from the dev UI', () => {
    ok({ method: 'POST', origin: 'http://localhost:7900', secFetchSite: 'same-origin', contentType: 'application/json', hasBody: true });
    ok({ method: 'POST', host: 'localhost:5190', origin: 'http://localhost:5190', secFetchSite: 'same-origin', contentType: 'application/json; charset=utf-8', hasBody: true });
    ok({ method: 'POST', origin: 'http://127.0.0.1:7900', host: '127.0.0.1:7900' });
    ok({ method: 'GET', secFetchSite: 'same-origin' });
    ok({ method: 'GET', secFetchSite: 'none' }); // typed in the address bar
    ok({ upgrade: true, origin: 'http://localhost:5190', host: 'localhost:5190' });
  });

  it('lets local processes through (tool servers, hooks, the CLI send no Origin)', () => {
    ok({ method: 'POST', contentType: undefined, hasBody: true });
    ok({ method: 'POST', host: '127.0.0.1:7900', contentType: 'application/json', hasBody: true });
    ok({ upgrade: true });
  });

  it('refuses any other website, including a no-preflight text/plain POST', () => {
    refused({ method: 'POST', origin: 'https://evil.example', secFetchSite: 'cross-site', contentType: 'text/plain;charset=UTF-8', hasBody: true }, /cross-site|another site/);
    refused({ method: 'POST', origin: 'https://evil.example', contentType: 'application/json', hasBody: true }, /another site/);
    refused({ method: 'GET', secFetchSite: 'cross-site' }, /cross-site/); // <img src=…> from another site
    refused({ upgrade: true, origin: 'https://evil.example' }, /another site/); // reading /ws from a page
    refused({ method: 'POST', origin: 'null', hasBody: true }, /another site/); // sandboxed iframes, file:// pages
  });

  it('refuses apps on this Mac that are not Drydock (agent-built apps, other dev servers)', () => {
    refused({ method: 'POST', origin: 'http://quick-video-cutter.localhost:7900', contentType: 'application/json', hasBody: true }, /another site/);
    refused({ method: 'POST', origin: 'http://localhost:3000', contentType: 'application/json', hasBody: true }, /another site/);
  });

  it('refuses DNS rebinding: the Host must name this machine', () => {
    refused({ host: 'evil.example:7900' }, /unknown host/);
    refused({ host: 'evil.example:7900', method: 'POST', origin: 'http://evil.example:7900' }, /unknown host/);
    refused({ host: undefined }, /unknown host/);
  });

  it('a browser write needs an Origin and a JSON body', () => {
    refused({ method: 'POST', secFetchSite: 'same-origin', hasBody: true, contentType: 'application/json' }, /missing origin/);
    refused({ method: 'POST', origin: 'http://localhost:7900', contentType: 'text/plain', hasBody: true }, /JSON/);
    ok({ method: 'POST', origin: 'http://localhost:7900' }); // a POST with no body
  });

  it('a host the user set on purpose (HOST=…) is allowed too', () => {
    const lan = gatePolicy(7900, 5190, ['192.168.1.20', 'fe80::1']);
    assert.equal(checkRequest(req({ host: '192.168.1.20:7900', method: 'POST', origin: 'http://192.168.1.20:7900', contentType: 'application/json', hasBody: true }), lan), null);
    assert.ok(lan.hosts.has('[fe80::1]'), 'IPv6 addresses are bracketed like a Host header');
    assert.equal(checkRequest(req({ host: 'evil.example:7900' }), lan), 'unknown host', 'still no rebinding');
    assert.equal(hostName('[::1]:7900'), '[::1]');
    assert.equal(hostName('LocalHost:7900'), 'localhost');
  });
});
