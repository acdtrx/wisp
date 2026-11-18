import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkMigrationModule, ledgerEntry, migrationFileNames, parseLedger, pendingMigrations, recordRun,
} from './stateMigrationLedger.js';

const run = async () => {};

test('migration files are the .js names, in id order', () => {
  assert.deepEqual(
    migrationFileNames(['0002-b.js', '.gitkeep', '0001-a-b.js', 'README.md', '0010-c.js']),
    ['0001-a-b.js', '0002-b.js', '0010-c.js'],
  );
  assert.deepEqual(migrationFileNames(['.gitkeep']), []);
});

test('a .js file not named NNNN-short-name.js is a setup error', () => {
  for (const bad of ['1-a.js', '0001_a.js', '0001-A.js', '0001-.js', '0001-a--b.js', 'helper.js']) {
    assert.throws(() => migrationFileNames(['0001-ok.js', bad]), (err) => {
      assert.equal(err.code, 'MIGRATION_SETUP');
      assert.match(err.message, new RegExp(bad.replace('.', '\\.')));
      return true;
    });
  }
});

test('a migration module exports its file name as id, a description and run()', () => {
  const mod = { id: '0003-x', description: 'Does x', run, extra: 1 };
  assert.deepEqual(checkMigrationModule('0003-x.js', mod), { id: '0003-x', description: 'Does x', run });
});

test('a module with the wrong id, no description or no run() is a setup error', () => {
  const cases = [
    [{ id: '0003-y', description: 'd', run }, /exports id "0003-y", expected "0003-x"/],
    [{ description: 'd', run }, /exports id undefined/],
    [{ id: '0003-x', description: '', run }, /missing description/],
    [{ id: '0003-x', run }, /missing description/],
    [{ id: '0003-x', description: 'd', run: 'no' }, /missing run\(ctx\)/],
  ];
  for (const [mod, message] of cases) {
    assert.throws(() => checkMigrationModule('0003-x.js', mod), (err) => {
      assert.equal(err.code, 'MIGRATION_SETUP');
      assert.match(err.message, message);
      return true;
    });
  }
});

test('no ledger file is an empty ledger', () => {
  assert.deepEqual(parseLedger(null, '/c/migrations.json'), { applied: [] });
});

test('a ledger file is read as written', () => {
  const ledger = { applied: [{ id: '0001-a', at: 't', result: 'ok', changes: [] }] };
  assert.deepEqual(parseLedger(JSON.stringify(ledger), '/c/migrations.json'), ledger);
});

test('a ledger that is not JSON, or has no applied array, is a setup error naming the file', () => {
  for (const text of ['{', '', 'null', '[]', '{"applied":{}}', '{}']) {
    assert.throws(() => parseLedger(text, '/c/migrations.json'), (err) => {
      assert.equal(err.code, 'MIGRATION_SETUP');
      assert.match(err.message, /\/c\/migrations\.json/);
      return true;
    });
  }
});

test('pending: every migration without an ok entry, in the order given', () => {
  const migrations = ['0001-a', '0002-b', '0003-c', '0004-d'].map((id) => ({ id }));
  const ledger = {
    applied: [
      { id: '0003-c', result: 'ok' },
      { id: '0002-b', result: 'error' },
      { id: '0009-gone', result: 'ok' },
      { id: '0001-a', result: 'ok' },
    ],
  };
  assert.deepEqual(pendingMigrations(migrations, ledger).map((m) => m.id), ['0002-b', '0004-d']);
  assert.deepEqual(pendingMigrations(migrations, { applied: [] }).map((m) => m.id), ['0001-a', '0002-b', '0003-c', '0004-d']);
});

test('a ledger entry records ok, or error with the message', () => {
  assert.deepEqual(
    ledgerEntry('0001-a', { at: 't', changes: ['x'] }),
    { id: '0001-a', at: 't', result: 'ok', changes: ['x'] },
  );
  assert.deepEqual(
    ledgerEntry('0001-a', { at: 't', changes: [], error: new Error('boom') }),
    { id: '0001-a', at: 't', result: 'error', changes: [], error: 'boom' },
  );
  const raw = Object.assign(new Error('short'), { raw: 'libvirt said no' });
  assert.equal(ledgerEntry('0001-a', { at: 't', changes: [], error: raw }).error, 'libvirt said no');
});

test('recording a run keeps one entry per id and the entries of other ids', () => {
  const ledger = {
    applied: [
      { id: '0001-a', result: 'ok' },
      { id: '0002-b', result: 'error' },
      { id: '0009-gone', result: 'ok' },
    ],
  };
  const next = recordRun(ledger, { id: '0002-b', result: 'ok' });
  assert.deepEqual(next.applied, [
    { id: '0001-a', result: 'ok' },
    { id: '0009-gone', result: 'ok' },
    { id: '0002-b', result: 'ok' },
  ]);
  assert.equal(ledger.applied[1].result, 'error', 'the ledger given is left as it was');
  assert.deepEqual(recordRun({ applied: [] }, { id: '0001-a', result: 'ok' }).applied, [{ id: '0001-a', result: 'ok' }]);
});
