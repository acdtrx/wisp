/*
 * The two fetches against one stub server on 127.0.0.1: the operator fetch
 * reaches it, follows no redirect and honours the caller's signal; the SSRF
 * guard refuses it before a request is sent.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { fetchOperatorEndpoint, ssrfSafeFetch } from './index.js';

const hits = { ok: 0, redirect: 0, hang: 0 };
let server;
let base;
let port;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok') {
      hits.ok += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hello: 'stub' }));
    } else if (req.url === '/redirect') {
      hits.redirect += 1;
      res.writeHead(302, { location: '/ok' });
      res.end();
    } else if (req.url === '/hang') {
      hits.hang += 1; // never answers: the caller's signal ends the wait
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ({ port } = server.address());
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('the operator fetch reaches a loopback address', async () => {
  const res = await fetchOperatorEndpoint(`${base}/ok`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { hello: 'stub' });
});

test('the operator fetch answers a redirect as is, without following it', async () => {
  const okHits = hits.ok;
  const res = await fetchOperatorEndpoint(`${base}/redirect`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/ok');
  await res.arrayBuffer();
  assert.equal(hits.ok, okHits);
});

test("the operator fetch ends at the caller's signal", async () => {
  await assert.rejects(
    fetchOperatorEndpoint(`${base}/hang`, { signal: AbortSignal.timeout(100) }),
    (err) => err.name === 'TimeoutError',
  );
  assert.equal(hits.hang, 1);
});

test('the operator fetch refuses a URL that is not http or https', async () => {
  await assert.rejects(fetchOperatorEndpoint('file:///etc/passwd'), { code: 'INVALID_URL' });
});

test('ssrfSafeFetch refuses the same loopback stub before sending a request', async () => {
  const okHits = hits.ok;
  await assert.rejects(ssrfSafeFetch(`${base}/ok`), { code: 'SSRF_BLOCKED' });
  await assert.rejects(ssrfSafeFetch(`http://localhost:${port}/ok`), { code: 'SSRF_BLOCKED' });
  assert.equal(hits.ok, okHits);
});
