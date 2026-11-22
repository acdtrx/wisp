/*
 * Reading a CNI ADD result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { primaryIPv4FromCni } from './containerManagerNetwork.js';

test('a CNI 1.0 ADD result, which has no version field, gives its address', () => {
  assert.equal(primaryIPv4FromCni([{ address: '10.79.1.165/24', gateway: '10.79.1.1', interface: 2 }]), '10.79.1.165/24');
  assert.equal(primaryIPv4FromCni([{ version: '6', address: 'fd00::5/64' }, { version: '4', address: '10.0.0.5/24' }]), '10.0.0.5/24');
  assert.equal(primaryIPv4FromCni([]), null);
});
