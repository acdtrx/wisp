/*
 * redefineVM against a stand-in libvirt (the Connect interface and one domain's
 * proxies, set where the manager looks them up): what it reads, what it defines,
 * and the order of writes to one domain.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { connectionState } from './vmManagerConnection.js';
import { redefineVM, definitionWritesQueued } from './vmManagerDefine.js';
import { isShutOff } from './libvirtConstants.js';

const PATH = '/org/libvirt/QEMU/domain/_1';

/** The stand-in domain: its definition (what the last define wrote), the defines and reads made. */
const libvirt = { xml: '', defined: [], xmlFlags: [], persistent: true, failDefine: false };

beforeEach(() => {
  libvirt.xml = '<domain type="kvm"><name>mi-q</name><vcpu>1</vcpu><devices><graphics type="vnc" passwd="s3cret"/></devices></domain>';
  libvirt.defined = [];
  libvirt.xmlFlags = [];
  libvirt.persistent = true;
  libvirt.failDefine = false;
  connectionState.domainProxyCache.clear();
  connectionState.connectIface = {
    DomainDefineXML: async (text) => {
      // Let other queued work run first, so an unordered queue would interleave here.
      await new Promise((resolve) => setImmediate(resolve));
      if (libvirt.failDefine) throw new Error('unsupported configuration');
      libvirt.defined.push(text);
      libvirt.xml = text;
    },
  };
  connectionState.domainProxyCache.set(PATH, {
    iface: { GetXMLDesc: async (flags) => { libvirt.xmlFlags.push(flags); return libvirt.xml; } },
    props: {
      Get: async (_iface, prop) => {
        if (prop === 'Persistent') return libvirt.persistent;
        return null;
      },
    },
  });
});

const vcpuOf = (xml) => Number(/<vcpu>(\d+)<\/vcpu>/.exec(xml)[1]);

test('a change is defined back from the secure inactive definition, a console password kept', async () => {
  assert.equal(await redefineVM(PATH, (dom) => { dom.vcpu = 2; }), true);
  assert.deepEqual(libvirt.xmlFlags, [3]);
  assert.equal(libvirt.defined.length, 1);
  assert.match(libvirt.defined[0], /passwd="s3cret"/);
  assert.equal(vcpuOf(libvirt.defined[0]), 2);
});

test('a change that returns false defines nothing', async () => {
  assert.equal(await redefineVM(PATH, () => false), false);
  assert.deepEqual(libvirt.defined, []);
});

test('a transient domain: a change it would need is refused, or skipped when asked; no change is no error', async () => {
  libvirt.persistent = false;
  await assert.rejects(redefineVM(PATH, (dom) => { dom.vcpu = 2; }), (err) => err.code === 'VM_TRANSIENT' && /mi-q/.test(err.message));
  assert.equal(await redefineVM(PATH, (dom) => { dom.vcpu = 2; }, { skipTransient: true }), false);
  assert.equal(await redefineVM(PATH, () => false), false);
  assert.deepEqual(libvirt.defined, []);
});

test('writes to one domain run in order: each reads what the one before it defined', async () => {
  const add = (dom) => { dom.vcpu = Number(dom.vcpu) + 1; };
  await Promise.all([redefineVM(PATH, add), redefineVM(PATH, add), redefineVM(PATH, add)]);
  assert.deepEqual(libvirt.defined.map(vcpuOf), [2, 3, 4]);
});

test('a writer that throws or whose define fails does not stop the next one, and an idle domain holds no entry', async () => {
  const add = (dom) => { dom.vcpu = Number(dom.vcpu) + 1; };
  const thrown = redefineVM(PATH, () => { throw new Error('precondition'); });
  libvirt.failDefine = true;
  const failed = redefineVM(PATH, add);
  const next = redefineVM(PATH, (dom) => { libvirt.failDefine = false; add(dom); });
  await assert.rejects(thrown, /precondition/);
  await assert.rejects(failed, (err) => err.code === 'LIBVIRT_ERROR');
  assert.equal(await next, true);
  assert.deepEqual(libvirt.defined.map(vcpuOf), [2]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(definitionWritesQueued(), 0);
});

test('only shut off is off', () => {
  assert.equal(isShutOff(5), true);
  for (const code of [0, 1, 2, 3, 4, 6, 7]) assert.equal(isShutOff(code), false);
});
