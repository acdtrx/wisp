import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser } from '../testing/fakeBrowser.js';

installBrowser();
const { RECORD, RECORD_KINDS } = await import('./records.js');

test('every kind named by a workload can be gone, by its subject\'s own not-found only', () => {
  const gone = Object.fromEntries(Object.entries(RECORD_KINDS).filter(([, k]) => k.goneCodes).map(([name, k]) => [name, k.goneCodes]));
  assert.deepEqual(gone, {
    [RECORD.VM]: ['VM_NOT_FOUND'],
    [RECORD.VM_USB]: ['VM_NOT_FOUND'],
    [RECORD.VM_CLOUD_INIT]: ['VM_NOT_FOUND'],
    [RECORD.VM_XML]: ['VM_NOT_FOUND'],
    [RECORD.CONTAINER]: ['CONTAINER_NOT_FOUND'],
    [RECORD.CONTAINER_MOUNT_USAGE]: ['CONTAINER_NOT_FOUND'],
    [RECORD.CONTAINER_RUNS]: ['CONTAINER_NOT_FOUND'],
    [RECORD.MOUNT_FILE_CONTENT]: ['CONTAINER_MOUNT_NOT_FOUND', 'CONTAINER_NOT_FOUND'],
  });
  for (const [name, kind] of Object.entries(RECORD_KINDS)) {
    if (kind.goneCodes) assert.ok(!kind.singleton, `${name}: a singleton is never gone`);
  }
});
