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
