/*
 * Image names: Docker's normalization, the `localhost/` rule, and the name an
 * uploaded archive's image is stored under.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeImageRef, isLocalImageRef, localImageNameFor, isImageImportWorkName, isTaggedImageName,
} from './containerImageRef.js';

test('a ref is normalized by Docker\'s rule', () => {
  assert.equal(normalizeImageRef('caddy:2'), 'docker.io/library/caddy:2');
  assert.equal(normalizeImageRef('user/app'), 'docker.io/user/app');
  assert.equal(normalizeImageRef('nas:5000/app'), 'nas:5000/app');
  assert.equal(normalizeImageRef('localhost/app:v1'), 'localhost/app:v1');
});

test('a ref is this host\'s own when its registry host is localhost, and a registry on localhost\'s port is not', () => {
  assert.equal(isLocalImageRef('localhost/myapp:v1'), true);
  assert.equal(isLocalImageRef('localhost/me/app'), true);
  // Any case, and the fully qualified host.
  assert.equal(isLocalImageRef('LOCALHOST/app'), true);
  assert.equal(isLocalImageRef('LocalHost/app:v1'), true);
  assert.equal(isLocalImageRef('localhost./app'), true);
  assert.equal(isLocalImageRef('LOCALHOST:5000/app'), false);
  for (const ref of ['localhost:5000/myapp:v1', 'myapp:v1', 'localhost', 'localhost:v1', 'docker.io/library/busybox:latest', 'ghcr.io/me/app']) {
    assert.equal(isLocalImageRef(ref), false, ref);
  }
});

test('an archive\'s image is stored under its name with the registry host replaced by localhost', () => {
  // A bare name, as `docker save myapp:v1` writes it (containerd reads it normalized).
  assert.equal(localImageNameFor('myapp:v1'), 'localhost/myapp:v1');
  assert.equal(localImageNameFor('docker.io/library/myapp:v1'), 'localhost/myapp:v1');
  // A name with a registry host.
  assert.equal(localImageNameFor('ghcr.io/me/app:2'), 'localhost/me/app:2');
  assert.equal(localImageNameFor('nas:5000/team/app:3'), 'localhost/team/app:3');
  // Docker Hub: `library/` goes with the host, a user's repository keeps its path.
  assert.equal(localImageNameFor('library/nginx:latest'), 'localhost/nginx:latest');
  assert.equal(localImageNameFor('nginx:latest'), 'localhost/nginx:latest');
  assert.equal(localImageNameFor('docker.io/me/app:1'), 'localhost/me/app:1');
  // Already under localhost/ (podman's local builds): kept.
  assert.equal(localImageNameFor('localhost/podapp:dev'), 'localhost/podapp:dev');
});

test('the names an import works under are its own prefix\'s only', () => {
  assert.equal(isImageImportWorkName('localhost/wisp-import-0123abcd@sha256:00'), true);
  for (const name of ['localhost/wisp-importer:1', 'localhost/myapp:v1', 'wisp-import-1', '', null]) {
    assert.equal(isImageImportWorkName(name), false, String(name));
  }
});

test('an image reference of a name and a tag follows the reference grammar', () => {
  for (const ok of ['myapp', 'myapp:v1', 'docker.io/library/myapp:v1', 'ghcr.io/me/app:2', 'nas:5000/team/app:3', 'LOCALHOST/app:v1', 'localhost/a.b_c__d-e:1.0-rc_1']) {
    assert.equal(isTaggedImageName(ok), true, ok);
  }
  for (const bad of ['', 'MyApp:v1', 'my app:v1', 'localhost/', 'localhost./app', 'app@sha256:0123', 'app:', '-app', 'app:-v1', `a/${'b'.repeat(260)}`, 'a'.repeat(1000), null]) {
    assert.equal(isTaggedImageName(bad), false, String(bad).slice(0, 40));
  }
});
