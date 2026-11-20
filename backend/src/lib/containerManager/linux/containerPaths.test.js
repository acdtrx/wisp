import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pathUnder } from './containerPaths.js';

const ROOT = '/srv/backups';

test('a name or a timestamp joined below the root comes back resolved', () => {
  assert.equal(pathUnder(ROOT, 'containers', 'ct-a', '2026-07-14T18-46-18'), '/srv/backups/containers/ct-a/2026-07-14T18-46-18');
  assert.equal(pathUnder(`${ROOT}/`, 'ct.a'), '/srv/backups/ct.a');
});

test('a segment that leaves the root is refused: .., an absolute path, a separator that climbs out', () => {
  for (const segments of [['..'], ['containers', '..', '..'], ['/etc'], ['containers', '/etc/passwd'], ['../backups-other'], ['ct-a/../../x'], ['']]) {
    assert.throws(() => pathUnder(ROOT, ...segments), (err) => err.code === 'PATH_NOT_ALLOWED', JSON.stringify(segments));
  }
});
