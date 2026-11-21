import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDomainRaw, buildXml, removeWispPref, parseVMFromXML, setWispProfile, getWispProfile, profileFromDefinition,
} from './vmManagerXml.js';

const domain = (metadata) => `<domain type="kvm"><name>web</name><uuid>00000000-0000-4000-8000-000000000001</uuid>${metadata}<memory unit="KiB">1048576</memory><vcpu placement="static">1</vcpu></domain>`;
const prefs = (children) => `<wisp:prefs xmlns:wisp="https://wisp.local/app">${children}</wisp:prefs>`;

function removed(xml, key) {
  const parsed = parseDomainRaw(xml);
  const changed = removeWispPref(parsed.domain, key);
  return { changed, xml: buildXml(parsed) };
}

test('a pref is removed and the other prefs stay', () => {
  const { changed, xml } = removed(domain(`<metadata>${prefs('<wisp:localDns>true</wisp:localDns><wisp:icon>debian</wisp:icon>')}</metadata>`), 'localDns');
  assert.equal(changed, true);
  assert.equal(xml, domain(`<metadata>${prefs('<wisp:icon>debian</wisp:icon>')}</metadata>`));
  assert.equal(parseVMFromXML(xml).iconId, 'debian');
});

test('the last pref takes wisp:prefs with it, and <metadata> once nothing else is in it', () => {
  assert.equal(removed(domain(`<metadata>${prefs('<wisp:localDns>false</wisp:localDns>')}</metadata>`), 'localDns').xml, domain(''));
  const other = '<libosinfo:libosinfo xmlns:libosinfo="http://libosinfo.org/xmlns/libvirt/domain/1.0"><libosinfo:os id="http://ubuntu.com/ubuntu/24.04"></libosinfo:os></libosinfo:libosinfo>';
  assert.equal(
    removed(domain(`<metadata>${other}${prefs('<wisp:localDns>false</wisp:localDns>')}</metadata>`), 'localDns').xml,
    domain(`<metadata>${other}</metadata>`),
  );
});

test('a domain without the pref is left as it is', () => {
  for (const metadata of ['', `<metadata>${prefs('<wisp:icon>debian</wisp:icon>')}</metadata>`]) {
    const xml = domain(metadata);
    assert.deepEqual(removed(xml, 'localDns'), { changed: false, xml });
  }
});

test('the profile is stored beside the other prefs and read back', () => {
  const parsed = parseDomainRaw(domain(`<metadata>${prefs('<wisp:icon>debian</wisp:icon>')}</metadata>`));
  assert.equal(getWispProfile(parsed.domain), null);
  setWispProfile(parsed.domain, 'linux');
  const xml = buildXml(parsed);
  assert.equal(xml, domain(`<metadata>${prefs('<wisp:icon>debian</wisp:icon><wisp:profile>linux</wisp:profile>')}</metadata>`));
  assert.equal(parseVMFromXML(xml).profile, 'linux');
  assert.equal(parseVMFromXML(domain('')).profile, null);
});

test('a definition made before profiles reads as windows-11 with the Hyper-V features, else linux', () => {
  const windows = parseDomainRaw('<domain><name>w</name><features><acpi/><hyperv mode="custom"><relaxed state="on"/></hyperv></features></domain>');
  const linux = parseDomainRaw('<domain><name>l</name><features><acpi/></features></domain>');
  assert.equal(profileFromDefinition(windows.domain), 'windows-11');
  assert.equal(profileFromDefinition(linux.domain), 'linux');
  assert.equal(profileFromDefinition(parseDomainRaw('<domain><name>x</name></domain>').domain), 'linux');
});
