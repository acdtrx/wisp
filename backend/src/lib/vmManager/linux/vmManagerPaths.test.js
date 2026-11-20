import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pathUnder } from './vmManagerPaths.js';

const ROOT = '/srv/backups';

test('a name or a timestamp joined below the root comes back resolved', () => {
  assert.equal(pathUnder(ROOT, 'vms', 'vm-a', '2026-05-08T08-35-22'), '/srv/backups/vms/vm-a/2026-05-08T08-35-22');
  assert.equal(pathUnder(`${ROOT}/`, 'vm.a'), '/srv/backups/vm.a');
  assert.equal(pathUnder(ROOT, '..a'), '/srv/backups/..a');
});

test('a segment that leaves the root is refused: .., an absolute path, a separator that climbs out', () => {
  for (const segments of [['..'], ['vms', '..', '..'], ['/etc'], ['vms', '/etc/passwd'], ['../backups-other'], ['vm-a/../../x'], ['']]) {
    assert.throws(() => pathUnder(ROOT, ...segments), (err) => err.code === 'PATH_NOT_ALLOWED', JSON.stringify(segments));
  }
});

test('each segment is one path segment: a climb to a sibling, an empty or a dot segment, a NUL are refused', () => {
  const ts = '2026-05-08T08-35-22';
  const cases = [
    ['vms', '../containers/ct-a', ts],
    ['vms', '', ''],
    ['vms', 'x/..', '.'],
    ['vms', '..', 'vms'],
    ['vms', '.'],
    ['vms', 'a/b'],
    ['vms', 'a\0b'],
  ];
  for (const segments of cases) {
    assert.throws(() => pathUnder(ROOT, ...segments), (err) => err.code === 'PATH_NOT_ALLOWED', JSON.stringify(segments));
  }
});
