import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateEnvPatch } from './containerEnvPatch.js';

const refusal = (detail) => (err) => err.code === 'CONFIG_ERROR' && err.message === detail;

test('an env change of named entries and removals passes', () => {
  validateEnvPatch({ A: { value: '1' }, S: { value: 's', secret: true }, GONE: null, KEEP: {} });
});

test('an env change is refused for a key of nothing, or an entry, a value or a flag of the wrong type', () => {
  assert.throws(() => validateEnvPatch(null), refusal('envPatch must be an object'));
  assert.throws(() => validateEnvPatch([]), refusal('envPatch must be an object'));
  assert.throws(() => validateEnvPatch({ '': { value: 'x' } }), refusal('envPatch keys must be non-empty strings'));
  assert.throws(() => validateEnvPatch({ '  ': null }), refusal('envPatch keys must be non-empty strings'));
  assert.throws(() => validateEnvPatch({ A: 'x' }), refusal('envPatch entry for "A" must be an object or null'));
  assert.throws(() => validateEnvPatch({ A: { value: 1 } }), refusal('envPatch value for "A" must be a string'));
  assert.throws(() => validateEnvPatch({ A: { value: 'x', secret: 'yes' } }), refusal('envPatch secret flag for "A" must be boolean'));
});
