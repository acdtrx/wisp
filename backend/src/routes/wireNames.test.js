import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as wireNames from '../../../shared/wireNames.js';

/* The names are the wire's: a client of another release reads them. Changing one is a
 * deliberate change of the API, made in both shared/wireNames.js and this fixture. */
test('the wire names are the ones the API documents', () => {
  const pinned = JSON.parse(readFileSync(new URL('./fixtures/wireNames.json', import.meta.url), 'utf8'));
  assert.deepEqual({ TOPIC: wireNames.TOPIC, CHANGE_KIND: wireNames.CHANGE_KIND, JOB_KIND: wireNames.JOB_KIND }, pinned);
  assert.deepEqual(Object.keys(wireNames).sort(), ['CHANGE_KIND', 'JOB_KIND', 'TOPIC']);
});
