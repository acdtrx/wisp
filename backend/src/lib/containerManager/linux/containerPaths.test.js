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

test('each segment is one path segment: a climb to a sibling, an empty or a dot segment, a NUL are refused', () => {
  const ts = '2026-05-08T08-35-22';
  const cases = [
    ['containers', '../vms/vm-a', ts],
    ['containers', '', ''],
    ['containers', 'x/..', '.'],
    ['containers', '..', 'containers'],
    ['containers', '.'],
    ['containers', 'a/b'],
    ['containers', 'a\0b'],
  ];
  for (const segments of cases) {
    assert.throws(() => pathUnder(ROOT, ...segments), (err) => err.code === 'PATH_NOT_ALLOWED', JSON.stringify(segments));
  }
});
