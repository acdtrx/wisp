/*
 * The one read of a container.json: its three answers besides the config itself.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readContainerConfigFile } from './containerManagerConfigIo.js';

const root = mkdtempSync(path.join(tmpdir(), 'wisp-config-read-'));
after(() => rmSync(root, { recursive: true, force: true }));

const file = (name, text) => {
  const p = path.join(root, name);
  writeFileSync(p, text);
  return p;
};
const code = async (p) => readContainerConfigFile(p, 'c').then(() => 'read', (err) => err.code);

test('a config that is a JSON object is read', async () => {
  assert.deepEqual(await readContainerConfigFile(file('ok.json', '{"name":"c","mounts":[]}'), 'c'), { name: 'c', mounts: [] });
});

test('a missing file, or a missing directory, is CONTAINER_NOT_FOUND', async () => {
  assert.equal(await code(path.join(root, 'none.json')), 'CONTAINER_NOT_FOUND');
  assert.equal(await code(path.join(root, 'ok.json', 'container.json')), 'CONTAINER_NOT_FOUND');
});

test('a file that cannot be read is INTERNAL_ERROR', async () => {
  const dir = path.join(root, 'is-a-dir.json');
  mkdirSync(dir);
  assert.equal(await code(dir), 'INTERNAL_ERROR');
});

test('a file that is not a JSON object is PARSE_ERROR', async () => {
  for (const [name, text] of [['cut.json', '{"name":"c",'], ['null.json', 'null'], ['list.json', '[]'], ['num.json', '3']]) {
    assert.equal(await code(file(name, text)), 'PARSE_ERROR', name);
  }
});
