/*
 * setMissingVMProfile against a stand-in libvirt (the connection's Connect interface
 * and one domain's proxies, set where the manager looks them up): what it reads, and
 * what it defines back.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { connectionState } from './vmManagerConnection.js';
import { setMissingVMProfile } from './vmManagerConfig.js';

const PATH = '/org/libvirt/QEMU/domain/_1';
const XML = `<domain type="kvm"><name>dubi</name><devices><graphics type="vnc" passwd="s3cret"/></devices></domain>`;

let defined;
let xmlFlags;

function domain({ persistent, xml = XML }) {
  defined = [];
  xmlFlags = [];
  connectionState.connectIface = {
    DomainLookupByName: async () => PATH,
    DomainDefineXML: async (text) => { defined.push(text); },
  };
  connectionState.domainProxyCache.set(PATH, {
    iface: { GetXMLDesc: async (flags) => { xmlFlags.push(flags); return xml; } },
    props: { Get: async (iface, prop) => (iface === 'org.libvirt.Domain' && prop === 'Persistent' ? persistent : null) },
  });
}

beforeEach(() => connectionState.domainProxyCache.clear());

test('a transient domain is left alone: no define, no profile', async () => {
  domain({ persistent: false });
  assert.deepEqual(await setMissingVMProfile('dubi'), { changed: false, profile: null });
  assert.deepEqual([defined, xmlFlags], [[], []]);
});

test('a persistent domain without a profile is defined back from its secure inactive XML, with the profile added', async () => {
  domain({ persistent: true });
  assert.deepEqual(await setMissingVMProfile('dubi'), { changed: true, profile: 'linux' });
  assert.deepEqual(xmlFlags, [3]);
  assert.equal(defined.length, 1);
  assert.match(defined[0], /<wisp:profile>linux<\/wisp:profile>/);
  assert.match(defined[0], /passwd="s3cret"/);
});

test('a domain with a profile is not defined again', async () => {
  domain({
    persistent: true,
    xml: '<domain type="kvm"><name>gubi</name><metadata><wisp:prefs xmlns:wisp="https://wisp.local/app"><wisp:profile>other</wisp:profile></wisp:prefs></metadata></domain>',
  });
  assert.deepEqual(await setMissingVMProfile('gubi'), { changed: false, profile: 'other' });
  assert.deepEqual(defined, []);
});
