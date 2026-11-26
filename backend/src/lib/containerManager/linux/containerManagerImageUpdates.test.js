/*
 * The image update check passes a localhost/ image without pulling it, with
 * the images and the container list mocked (node --test
 * --experimental-test-module-mocks); every pull is recorded.
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

const pulls = [];
const digests = { 'localhost/busybox:latest': 'sha256:01', 'docker.io/library/busybox:latest': 'sha256:02' };
mock.module(new URL('./containerManagerPull.js', import.meta.url).href, {
  exports: { pullImage: async (ref) => { pulls.push(ref); } },
});
mock.module(new URL('./containerManagerImages.js', import.meta.url).href, {
  exports: {
    listContainerImages: async () => Object.entries(digests).map(([name, digest]) => ({ name, digest })),
    getImageDigest: async (ref) => digests[ref] ?? null,
  },
});
mock.module(new URL('./containerManagerList.js', import.meta.url).href, {
  exports: { refreshContainerListCache: async () => {}, findContainersUsingImage: async () => [] },
});

const { checkAllImagesForUpdates, checkSingleImageForUpdates } = await import('./containerManagerImageUpdates.js');

test('a check of a localhost/ image skips it with CONTAINER_IMAGE_LOCAL and pulls nothing', async () => {
  pulls.length = 0;
  const events = [];
  const result = await checkSingleImageForUpdates('localhost/busybox:latest', (ev) => events.push(ev));
  assert.deepEqual(events.map((e) => e.step), ['checking', 'skipped']);
  assert.equal(events[1].cause.code, 'CONTAINER_IMAGE_LOCAL');
  assert.deepEqual(pulls, []);
  assert.equal(result.updated, 0);
});

test('a check of every image skips the localhost/ one and pulls the registry\'s', async () => {
  pulls.length = 0;
  const events = [];
  await checkAllImagesForUpdates((ev) => events.push(ev));
  const skipped = events.filter((e) => e.step === 'skipped');
  assert.deepEqual(skipped.map((e) => [e.ref, e.cause.code]), [['localhost/busybox:latest', 'CONTAINER_IMAGE_LOCAL']]);
  assert.deepEqual(pulls, ['docker.io/library/busybox:latest']);
});
