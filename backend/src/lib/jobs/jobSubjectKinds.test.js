import assert from 'node:assert/strict';
import test from 'node:test';

import { JOB_KIND } from '../../../../shared/wireNames.js';
import { SUBJECT_KINDS, assertEveryKindListed } from './jobSubjectKinds.js';

test('every job kind says whether it acts on a workload', () => {
  assert.deepEqual(Object.keys(SUBJECT_KINDS).sort(), Object.values(JOB_KIND).sort());
});

test('a kind left out of the table, or one the wire does not name, is refused', () => {
  const [first, ...rest] = Object.values(JOB_KIND);
  const without = Object.fromEntries(rest.map((kind) => [kind, null]));
  assert.throws(() => assertEveryKindListed(without, Object.values(JOB_KIND)), new RegExp(`missing ${first}`));
  assert.throws(
    () => assertEveryKindListed({ ...SUBJECT_KINDS, 'vm-teleport': null }, Object.values(JOB_KIND)),
    /unknown vm-teleport/,
  );
});
