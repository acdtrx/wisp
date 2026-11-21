import { test } from 'node:test';
import assert from 'node:assert/strict';

import { containerDraftProblems, createContainerBody, defaultContainerDraft, draftWithApp } from './containerDraft.js';

const APPS = [{ id: 'caddy-reverse-proxy', defaultImage: 'caddy:latest' }];

test('a plain container sends its name and image, trimmed', () => {
  const draft = { ...defaultContainerDraft(), name: ' web ', image: ' nginx:latest ' };
  assert.deepEqual(createContainerBody(draft), { name: 'web', image: 'nginx:latest' });
});

test('an app fills in its image and is sent', () => {
  const draft = draftWithApp({ ...defaultContainerDraft(), name: 'proxy' }, 'caddy-reverse-proxy', APPS);
  assert.equal(draft.image, 'caddy:latest');
  assert.deepEqual(createContainerBody(draft), { name: 'proxy', image: 'caddy:latest', app: 'caddy-reverse-proxy' });
});

test('going back to a plain container empties the image', () => {
  const app = draftWithApp(defaultContainerDraft(), 'caddy-reverse-proxy', APPS);
  assert.deepEqual(draftWithApp(app, null, APPS), { name: '', app: null, image: '' });
});

test('a name and an image are required', () => {
  assert.deepEqual(Object.keys(containerDraftProblems(defaultContainerDraft())), ['name', 'image']);
  assert.deepEqual(containerDraftProblems({ name: 'a', app: null, image: 'b' }), {});
});
