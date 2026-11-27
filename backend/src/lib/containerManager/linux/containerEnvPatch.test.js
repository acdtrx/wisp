import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateEnvPatch } from './containerEnvPatch.js';

const refusal = (detail) => (err) => err.code === 'CONFIG_ERROR' && err.message === detail;

test('an env change of named entries and removals passes', () => {
  validateEnvPatch({ A: { value: '1' }, S: { value: 's', secret: true }, GONE: null, KEEP: {} });
});

test('an env change is refused for a key of nothing, or an entry, a value or a flag of the wrong type', () => {
  assert.throws(() => validateEnvPatch(null), refusal('The env change must be an object of env variables'));
  assert.throws(() => validateEnvPatch([]), refusal('The env change must be an object of env variables'));
  assert.throws(() => validateEnvPatch({ '': { value: 'x' } }), refusal('An env variable needs a name: an empty one, or one of spaces only, is refused'));
  assert.throws(() => validateEnvPatch({ '  ': null }), refusal('An env variable needs a name: an empty one, or one of spaces only, is refused'));
  assert.throws(() => validateEnvPatch({ A: 'x' }), refusal('Env variable "A": give it as { value, secret }, or null to remove it'));
  assert.throws(() => validateEnvPatch({ A: { value: 1 } }), refusal('Env variable "A": its value must be a string'));
  assert.throws(() => validateEnvPatch({ A: { value: 'x', secret: 'yes' } }), refusal('Env variable "A": its secret flag must be true or false'));
});
