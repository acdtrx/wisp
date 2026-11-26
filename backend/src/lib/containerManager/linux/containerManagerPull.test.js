/*
 * The pull's one rule before containerd is called: a localhost/ ref is never
 * pulled. No containerd here: a pull that is tried fails on the way to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pullImage } from './containerManagerPull.js';

test('a localhost/ ref is not pulled: it is CONTAINER_IMAGE_NOT_FOUND, without reaching containerd', async () => {
  await assert.rejects(pullImage('localhost/myapp:v1'), { code: 'CONTAINER_IMAGE_NOT_FOUND' });
});

test('a registry ref is pulled, one on localhost\'s port among them', async () => {
  for (const ref of ['localhost:5000/myapp:v1', 'busybox:latest']) {
    await assert.rejects(pullImage(ref), (err) => err.code !== 'CONTAINER_IMAGE_NOT_FOUND', ref);
  }
});
