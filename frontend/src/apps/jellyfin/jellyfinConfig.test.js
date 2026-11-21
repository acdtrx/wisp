import { test } from 'node:test';
import assert from 'node:assert/strict';

import { libraryForm, libraryProblems, withGpu, withLibrary, withoutLibrary, withPublishedUrl } from './jellyfinConfig.js';

const stored = {
  libraries: [{ label: 'movies', sourceId: 'nas', subPath: 'media/movies' }, { label: 'shows', sourceId: 'nas', subPath: '' }],
  gpuEnabled: false,
  publishedUrl: 'http://jelly.local:8096',
};

test('a library saved replaces its row; a new one is added; a removed one goes', () => {
  assert.deepEqual(withLibrary(stored, 'shows', { label: 'tv', sourceId: 'usb', subPath: ' tv ' }).libraries[1], { label: 'tv', sourceId: 'usb', subPath: 'tv' });
  assert.equal(withLibrary(stored, null, libraryForm({ label: 'music', sourceId: 'nas' })).libraries.length, 3);
  assert.deepEqual(withoutLibrary(stored, 'movies').libraries.map((l) => l.label), ['shows']);
});

test('a library needs a free, plain label and a source', () => {
  assert.deepEqual(Object.keys(libraryProblems(stored, null, libraryForm(null))), ['label', 'sourceId']);
  assert.ok(libraryProblems(stored, null, { label: 'shows', sourceId: 'nas', subPath: '' }).label);
  assert.deepEqual(libraryProblems(stored, 'shows', { label: 'shows', sourceId: 'nas', subPath: '' }), {});
  assert.ok(libraryProblems(stored, null, { label: 'cache', sourceId: 'nas', subPath: '' }).label);
  assert.ok(libraryProblems(stored, null, { label: 'x', sourceId: 'nas', subPath: '../up' }).subPath);
});

test('the address and the GPU change alone', () => {
  assert.equal(withPublishedUrl(stored, ' http://j.local ').publishedUrl, 'http://j.local');
  const on = withGpu(stored, true);
  assert.equal(on.gpuEnabled, true);
  assert.deepEqual(on.libraries, stored.libraries);
});
