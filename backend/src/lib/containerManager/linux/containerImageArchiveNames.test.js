/*
 * The names an uploaded archive gives its images: each checked against the
 * image reference grammar, mapped to `localhost/`, and the archive refused
 * whole when one is wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { namedImages } from './containerImageArchiveNames.js';

/** A `saved` event of the import for an image of `digest` named by `annotations`. */
const saved = (digest, annotations = {}) => ({ name: `localhost/wisp-import-00@${digest}`, desc: { digest, mediaType: 'm', annotations } });
const named = (name, digest = 'sha256:01') => saved(digest, { 'io.containerd.image.name': name });

test('each name maps to its localhost/ name, in the archive\'s order; the index and unnamed images are left out', () => {
  const images = namedImages([
    saved('sha256:00'),
    named('docker.io/library/myapp:v1'),
    named('ghcr.io/me/app:2', 'sha256:02'),
    saved('sha256:03', { 'org.opencontainers.image.ref.name': 'v1' }),
    saved('sha256:04', { 'org.opencontainers.image.ref.name': 'localhost/podapp:dev' }),
  ]);
  assert.deepEqual(images.map((i) => [i.name, i.desc.digest]), [
    ['localhost/myapp:v1', 'sha256:01'],
    ['localhost/me/app:2', 'sha256:02'],
    ['localhost/podapp:dev', 'sha256:04'],
  ]);
});

test('an archive that names no image is CONTAINER_IMAGE_ARCHIVE_UNNAMED', () => {
  assert.throws(() => namedImages([saved('sha256:00'), saved('sha256:01', { 'org.opencontainers.image.ref.name': 'latest' })]), { code: 'CONTAINER_IMAGE_ARCHIVE_UNNAMED' });
});

test('a name that is not a valid image reference refuses the archive whole', () => {
  for (const bad of ['docker.io/library/My App:v1', 'docker.io/library/MyApp:v1', 'localhost/', 'localhost./app:v1', 'docker.io/library/app@sha256:01', 'a'.repeat(300)]) {
    assert.throws(() => namedImages([named('docker.io/library/ok:1', 'sha256:09'), named(bad)]), { code: 'CONTAINER_IMAGE_ARCHIVE_INVALID' }, bad);
  }
});

test('a name under Wisp\'s import prefix is refused', () => {
  assert.throws(() => namedImages([named('docker.io/library/wisp-import-1:v1')]), { code: 'CONTAINER_IMAGE_ARCHIVE_INVALID' });
});

test('two names that give one localhost/ name to different images refuse the archive, naming both; for one image they are one', () => {
  assert.throws(
    () => namedImages([named('docker.io/me/app:1', 'sha256:01'), named('ghcr.io/me/app:1', 'sha256:02')]),
    (err) => err.code === 'CONTAINER_IMAGE_ARCHIVE_INVALID' && err.message.includes('docker.io/me/app:1') && err.message.includes('ghcr.io/me/app:1'),
  );
  const images = namedImages([named('docker.io/me/app:1'), named('ghcr.io/me/app:1')]);
  assert.deepEqual(images.map((i) => i.name), ['localhost/me/app:1']);
});
