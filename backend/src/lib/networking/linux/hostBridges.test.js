/*
 * A container's IPv4 address from its /proc/<pid>/net/fib_trie text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ipv4CidrFromFibTrieText } from './hostBridges.js';

/** A busybox container's fib_trie on the test host's br0 (2026-11-22), read as the service user. */
const TINI = `Main:
  +-- 0.0.0.0/0 3 0 5
     +-- 0.0.0.0/4 2 0 2
        |-- 0.0.0.0
           /0 universe UNICAST
        +-- 10.79.1.0/24 2 0 1
           |-- 10.79.1.0
              /24 link UNICAST
           |-- 10.79.1.165
              /32 host LOCAL
           |-- 10.79.1.255
              /32 link BROADCAST
     +-- 127.0.0.0/8 2 0 2
        +-- 127.0.0.0/31 1 0 0
           |-- 127.0.0.0
              /8 host LOCAL
           |-- 127.0.0.1
              /32 host LOCAL
        |-- 127.255.255.255
           /32 link BROADCAST
     |-- 169.254.53.53
        /32 link UNICAST
Local:
  +-- 0.0.0.0/0 3 0 5
     +-- 0.0.0.0/4 2 0 2
        |-- 0.0.0.0
           /0 universe UNICAST
        +-- 10.79.1.0/24 2 0 1
           |-- 10.79.1.0
              /24 link UNICAST
           |-- 10.79.1.165
              /32 host LOCAL
           |-- 10.79.1.255
              /32 link BROADCAST
     +-- 127.0.0.0/8 2 0 2
        +-- 127.0.0.0/31 1 0 0
           |-- 127.0.0.0
              /8 host LOCAL
           |-- 127.0.0.1
              /32 host LOCAL
        |-- 127.255.255.255
           /32 link BROADCAST
     |-- 169.254.53.53
        /32 link UNICAST`;

test('the address a container holds, with its on-link prefix', () => {
  assert.equal(ipv4CidrFromFibTrieText(TINI), '10.79.1.165/24');
});

test('loopback, link-local and a namespace with no address give none', () => {
  const loopbackOnly = TINI.split('\n').filter((l) => !/10\.79\.1\.(0|165|255)|\/24 link|10\.79\.1\.0\/24/.test(l)).join('\n');
  assert.equal(ipv4CidrFromFibTrieText(loopbackOnly), null);
  assert.equal(ipv4CidrFromFibTrieText(''), null);
  assert.equal(ipv4CidrFromFibTrieText(undefined), null);
});

test('an address with no on-link route is a /32', () => {
  const text = 'Local:\n  +-- 0.0.0.0/0 3 0 5\n     |-- 192.168.7.9\n        /32 host LOCAL\n';
  assert.equal(ipv4CidrFromFibTrieText(text), '192.168.7.9/32');
});
