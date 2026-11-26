/*
 * A name an import works under is no image a caller can name: it answers
 * before containerd is asked. No containerd here: a lookup that were made
 * would fail on the way to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getImageDigest, resolveContainerImageRef } from './containerManagerImages.js';
import { getImageConfig } from './containerManagerPull.js';

const WORK_NAME = 'localhost/wisp-import-0123456789abcdef@sha256:00';

test('a caller\'s ref that is an import\'s own name is CONTAINER_IMAGE_NOT_FOUND: create, PATCH, the image update and a start', async () => {
  await assert.rejects(resolveContainerImageRef(WORK_NAME), { code: 'CONTAINER_IMAGE_NOT_FOUND' });
  await assert.rejects(getImageConfig(WORK_NAME), { code: 'CONTAINER_IMAGE_NOT_FOUND' });
  assert.equal(await getImageDigest(WORK_NAME), null);
});
