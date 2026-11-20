import { test } from 'node:test';
import assert from 'node:assert/strict';

import { configPathOverrideProblem } from './config.js';

const configDir = '/opt/wisp/config';

test('an installed Wisp refuses WISP_CONFIG_PATH, naming the key and where its configuration lives', () => {
  const problem = configPathOverrideProblem({ installed: true, env: { WISP_CONFIG_PATH: '/srv/wisp/wisp-config.json' }, configDir });
  assert.match(problem, /^WISP_CONFIG_PATH is set \(\/srv\/wisp\/wisp-config\.json\), but it is for development and tests/);
  assert.match(problem, /keeps its configuration in \/opt\/wisp\/config\/\./);
  assert.match(problem, /\/opt\/wisp\/config\/runtime\.env/);
});

test('an installed Wisp without the key, or with it empty (unset), starts', () => {
  assert.equal(configPathOverrideProblem({ installed: true, env: {}, configDir }), null);
  assert.equal(configPathOverrideProblem({ installed: true, env: { WISP_CONFIG_PATH: '' }, configDir }), null);
});

test('a git checkout (development, tests) keeps the override', () => {
  assert.equal(configPathOverrideProblem({ installed: false, env: { WISP_CONFIG_PATH: '/tmp/x/wisp-config.json' }, configDir }), null);
  assert.equal(configPathOverrideProblem({ installed: false, env: {}, configDir }), null);
});
