/*
 * The device builders create and every edit share, written out as libvirt reads them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildXml } from './vmManagerXml.js';
import { cdromElement, ensureScsiController, memballoonElement, nicElement } from './vmManagerDevices.js';

test('a balloon turned off is written as model none, so libvirt adds no virtio one', () => {
  assert.equal(buildXml({ memballoon: memballoonElement(false) }).trim(), '<memballoon model="none"></memballoon>');
  assert.match(buildXml({ memballoon: memballoonElement(true) }), /model="virtio"/);
});

test('an adapter carries its MAC, source and model only when given', () => {
  assert.deepEqual(nicElement({ source: 'br0' }), { '@_type': 'bridge', source: { '@_bridge': 'br0' } });
  assert.deepEqual(
    nicElement({ type: 'network', source: 'default', mac: '52:54:00:00:00:01', model: 'e1000' }),
    { '@_type': 'network', mac: { '@_address': '52:54:00:00:00:01' }, source: { '@_network': 'default' }, model: { '@_type': 'e1000' } },
  );
});

test('an empty CD-ROM has no source; the scsi controller is added once', () => {
  assert.equal('source' in cdromElement({ slot: 'sdc' }), false);
  const dom = { devices: { controller: { '@_type': 'usb' } } };
  ensureScsiController(dom);
  ensureScsiController(dom);
  assert.deepEqual(dom.devices.controller.map((c) => c['@_type']), ['usb', 'scsi']);
});
