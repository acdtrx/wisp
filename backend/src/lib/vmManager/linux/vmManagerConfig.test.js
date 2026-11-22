/*
 * The writers the state migrations call (setMissingVMProfile, removeVMPref,
 * setGraphicsListen) against a stand-in libvirt (the connection's Connect interface and
 * one domain's proxies, set where the manager looks them up): what they read, and what
 * they define back. A transient domain is never defined, and never fails them.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { connectionState } from './vmManagerConnection.js';
import { removeVMPref, setGraphicsListen, setMissingVMProfile } from './vmManagerConfig.js';

const PATH = '/org/libvirt/QEMU/domain/_1';
const XML = `<domain type="kvm"><name>dubi</name><devices><graphics type="vnc" passwd="s3cret"/></devices></domain>`;
/** A transient domain each writer would change: no profile, a retired pref, a console on every address. */
const TRANSIENT_XML = '<domain type="kvm"><name>mi-t</name><metadata><wisp:prefs xmlns:wisp="https://wisp.local/app"><wisp:localDns>true</wisp:localDns></wisp:prefs></metadata><devices><graphics type="vnc" listen="0.0.0.0"/></devices></domain>';

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

test('a transient domain each writer would change is left alone: not changed, nothing defined', async () => {
  domain({ persistent: false, xml: TRANSIENT_XML });
  assert.deepEqual(await setMissingVMProfile('mi-t'), { changed: false, profile: null });
  assert.deepEqual(await removeVMPref('mi-t', 'localDns'), { changed: false });
  assert.deepEqual(await setGraphicsListen('mi-t', '127.0.0.1'), { changed: false, previous: [] });
  assert.deepEqual(defined, []);
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

test('the same domain, persistent, is changed by each writer', async () => {
  domain({ persistent: true, xml: TRANSIENT_XML });
  assert.deepEqual(await removeVMPref('mi-t', 'localDns'), { changed: true });
  assert.deepEqual(await setGraphicsListen('mi-t', '127.0.0.1'), { changed: true, previous: ['0.0.0.0'] });
  assert.deepEqual(await setMissingVMProfile('mi-t'), { changed: true, profile: 'linux' });
  assert.equal(defined.length, 3);
});
