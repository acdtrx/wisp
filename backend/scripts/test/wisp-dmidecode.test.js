import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { helperBench } from './helperHarness.js';

const bench = helperBench();
after(() => bench.cleanup());

test('wisp-dmidecode refuses any argument before it runs anything', () => {
  for (const args of [['--type'], ['17'], ['']]) bench.assertRefused('wisp-dmidecode', args);
});

test('a dmidecode that fails is an error, not an empty list', () => {
  const r = bench.run('wisp-dmidecode', [], {
    standIns: { dmidecode: 'echo "/dev/mem: Permission denied" >&2; exit 1' },
  });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'wisp-dmidecode: dmidecode failed (exit 1): /dev/mem: Permission denied\n');
});

test('the modules DMI lists are one JSON array; none is []', () => {
  const table = [
    'Handle 0x0011, DMI type 17, 92 bytes',
    'Memory Device',
    '\tSize: 16 GB',
    '\tForm Factor: DIMM',
    '\tLocator: DIMM_A1',
    '\tType: DDR4',
    '\tSpeed: 3200 MT/s',
    '\tManufacturer: Samsung',
    '\tConfigured Voltage: 1.2 V',
    'Handle 0x0012, DMI type 17, 92 bytes',
    'Memory Device',
    '\tSize: No Module Installed',
  ].join('\\n');
  const r = bench.run('wisp-dmidecode', [], {
    standIns: { dmidecode: `printf '${table}\\n'` },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [{
    type: 'DDR4', sizeBytes: 16 * 1024 ** 3, speedMts: 3200, slot: 'DIMM_A1', formFactor: 'DIMM', manufacturer: 'Samsung', voltage: '1.2 V',
  }]);
  const none = bench.run('wisp-dmidecode', [], { standIns: { dmidecode: 'exit 0' } });
  assert.equal(none.code, 0, none.stderr);
  assert.deepEqual(JSON.parse(none.stdout), []);
});
