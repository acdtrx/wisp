/*
 * The two fetches against one stub server on 127.0.0.1: the operator fetch
 * reaches it, follows no redirect and honours the caller's signal; the SSRF
 * guard refuses it before a request is sent.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { fetchOperatorEndpoint, isPrivateIPv4, isPrivateIPv6, ssrfSafeFetch } from './index.js';

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
    } else if (req.url === '/declared-big') {
      res.writeHead(200, { 'content-length': '5000' });
      res.end('x'.repeat(5000));
    } else if (req.url === '/chunked-big') {
      // No Content-Length: the bound is met while reading.
      res.writeHead(200);
      for (let i = 0; i < 5; i += 1) res.write('x'.repeat(1000));
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

test('the operator fetch fails a body past maxBodyBytes, declared or read, and reads one within it', async () => {
  await assert.rejects(fetchOperatorEndpoint(`${base}/declared-big`, { maxBodyBytes: 4096 }), { code: 'DOWNLOAD_FAILED' });
  const chunked = await fetchOperatorEndpoint(`${base}/chunked-big`, { maxBodyBytes: 4096 });
  assert.equal(chunked.status, 200);
  await assert.rejects(chunked.text(), (err) => err.code === 'DOWNLOAD_FAILED' && /4096 bytes/.test(err.message));
  const within = await fetchOperatorEndpoint(`${base}/chunked-big`, { maxBodyBytes: 5000 });
  assert.equal((await within.text()).length, 5000);
  const json = await fetchOperatorEndpoint(`${base}/ok`, { maxBodyBytes: 100 });
  assert.deepEqual(await json.json(), { hello: 'stub' });
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

test('an IPv6 address that wraps a private IPv4 one is private, by the IPv4 rule', () => {
  const wrapping = [
    '::ffff:127.0.0.1', '::ffff:7f00:1', // IPv4-mapped
    '::ffff:0:127.0.0.1', '::ffff:0:c0a8:101', '0:0:0:0:ffff:0:10.0.0.1', // IPv4-translated
    '::127.0.0.1', '::7f00:1', '::10.0.0.1', // IPv4-compatible, ::/96
    '64:ff9b::127.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::192.168.1.1', // NAT64
    '2002:7f00:1::', '2002:c0a8:101::1', '2002:a00:1:0:0:0:0:1', // 6to4
  ];
  for (const addr of wrapping) assert.equal(isPrivateIPv6(addr), true, addr);
  const publicWrapped = ['::ffff:8.8.8.8', '::ffff:0:8.8.8.8', '::ffff:0:808:808', '64:ff9b::8.8.8.8', '2002:808:808::1'];
  for (const addr of publicWrapped) assert.equal(isPrivateIPv6(addr), false, addr);
});

test('site-local, unique-local, link-local, multicast and local-use NAT64 IPv6 are private', () => {
  for (const addr of ['fec0::1', 'feff::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', '64:ff9b:1::1', '::', '::1']) {
    assert.equal(isPrivateIPv6(addr), true, addr);
  }
  for (const addr of ['2001:db8::1', '2606:4700:4700::1111', 'fe00::1', '2003::1', '64:ff9b:2::1']) {
    assert.equal(isPrivateIPv6(addr), false, addr);
  }
});

test('a Teredo address is refused, whatever IPv4 address it carries', () => {
  for (const addr of ['2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:0:ffff::', '2001:0:0:0:0:0:0:0']) {
    assert.equal(isPrivateIPv6(addr), true, addr);
  }
  for (const addr of ['2001:1::1', '2001:4860:4860::8888']) assert.equal(isPrivateIPv6(addr), false, addr);
});

test('an IPv6 address that does not parse is refused', () => {
  for (const addr of ['1::2::3', '12345::', '1.2.3.4::', '::1.2.3.4:5', '1:2:3:4:5:6:7', 'g::1']) {
    assert.equal(isPrivateIPv6(addr), true, addr);
  }
  assert.equal(isPrivateIPv4('10.0.0.1'), true);
});

test('ssrfSafeFetch refuses an IPv6 literal that wraps the loopback stub', async () => {
  const okHits = hits.ok;
  for (const host of ['[::127.0.0.1]', '[::ffff:127.0.0.1]', '[::ffff:0:127.0.0.1]', '[64:ff9b::127.0.0.1]', '[2002:7f00:1::]', '[fec0::1]']) {
    await assert.rejects(ssrfSafeFetch(`http://${host}:${port}/ok`), { code: 'SSRF_BLOCKED' }, host);
  }
  assert.equal(hits.ok, okHits);
});
