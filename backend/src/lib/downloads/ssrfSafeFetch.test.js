/*
 * ssrfSafeFetch's Agents, one per hop, against a stub on 127.0.0.1
 * (node --test --experimental-test-module-mocks): the DNS lookup is mocked to
 * answer a public address, so the guard lets the request out, and each Agent
 * the fetch makes connects to the stub instead. Each Agent is closed, and the
 * last one only once the caller has read the body; a body is bounded when
 * the caller asks, and a redirect's is cancelled, never read.
 */
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import * as undici from 'undici';

/** Every Agent the fetch made: `{ closeCalled, closed, whenClosed }`. */
const agents = [];
let port;

function stubLookup(_hostname, opts, cb) {
  if (opts?.all) return cb(null, [{ address: '127.0.0.1', family: 4 }]);
  return cb(null, '127.0.0.1', 4);
}

class RecordingAgent extends undici.Agent {
  constructor(opts) {
    super({ ...opts, connect: { ...opts.connect, lookup: stubLookup } });
    let resolveClosed;
    this.record = { closeCalled: false, closed: false, whenClosed: new Promise((r) => { resolveClosed = r; }) };
    this.resolveClosed = resolveClosed;
    agents.push(this.record);
  }

  // undici's promise form calls the callback form on `this`: record only the outer call.
  close(callback) {
    if (callback) return super.close(callback);
    this.record.closeCalled = true;
    return super.close().then(() => {
      this.record.closed = true;
      this.resolveClosed();
    });
  }
}

mock.module('undici', { exports: { ...undici, Agent: RecordingAgent } });
mock.module('node:dns/promises', {
  // TEST-NET-3: a public address as far as the guard is concerned.
  exports: { lookup: async () => [{ address: '203.0.113.7', family: 4 }] },
});

const { ssrfSafeFetch } = await import('./downloadFromUrl.js');

const CHUNKS = 5;
const CHUNK = 'x'.repeat(1000);
let server;
/** Whether `/endless-redirect`'s body was cut before it ended. */
const endlessRedirectCut = Promise.withResolvers();

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/slow' });
      res.end();
    } else if (req.url === '/endless-redirect') {
      // A redirect whose body never ends: read, it would hold the fetch until its time limit.
      res.writeHead(302, { location: '/slow' });
      const timer = setInterval(() => res.write(CHUNK), 5);
      res.on('close', () => {
        clearInterval(timer);
        endlessRedirectCut.resolve(!res.writableFinished);
      });
    } else if (req.url === '/slow') {
      res.writeHead(200);
      let sent = 0;
      const timer = setInterval(() => {
        res.write(CHUNK);
        sent += 1;
        if (sent === CHUNKS) {
          clearInterval(timer);
          res.end();
        }
      }, 30);
    } else if (req.url === '/hang') {
      // never answers: the caller's signal ends the wait
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ({ port } = server.address());
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('each hop closes its Agent, and the last closes only after the body is read, in full', async () => {
  agents.length = 0;
  const res = await ssrfSafeFetch(`http://stub.test:${port}/redirect`);
  assert.equal(res.status, 200);
  assert.equal(agents.length, 2);
  const [hop, last] = agents;
  assert.equal(hop.closeCalled, true);
  await hop.whenClosed;
  assert.equal(last.closeCalled, true);
  assert.equal(last.closed, false);

  const body = await res.text();
  assert.equal(body.length, CHUNKS * CHUNK.length);
  await last.whenClosed;
});

test('a body past maxBodyBytes fails as it is read', async () => {
  const res = await ssrfSafeFetch(`http://stub.test:${port}/slow`, { maxBodyBytes: 2500 });
  assert.equal(res.status, 200);
  await assert.rejects(res.text(), (err) => err.code === 'DOWNLOAD_FAILED' && /2500 bytes/.test(err.message));
  const whole = await ssrfSafeFetch(`http://stub.test:${port}/slow`, { maxBodyBytes: CHUNKS * CHUNK.length });
  assert.equal((await whole.text()).length, CHUNKS * CHUNK.length);
});

test('a request that fails closes its Agent too', async () => {
  agents.length = 0;
  await assert.rejects(ssrfSafeFetch(`http://stub.test:${port}/hang`, { signal: AbortSignal.timeout(100) }), { name: 'TimeoutError' });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].closeCalled, true);
  await agents[0].whenClosed;
});

test("a redirect's body is cancelled, not read, and its Agent closed", async () => {
  agents.length = 0;
  const res = await ssrfSafeFetch(`http://stub.test:${port}/endless-redirect`, { signal: AbortSignal.timeout(2000) });
  assert.equal(res.status, 200);
  assert.equal(await endlessRedirectCut.promise, true);
  assert.equal(agents.length, 2);
  await agents[0].whenClosed;
  assert.equal((await res.text()).length, CHUNKS * CHUNK.length);
});
