import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cliBaseUrl, cliInstallScript } from './cliDistribution.js';

test('the install address is the advertised URL\'s origin when one is set, else the request\'s', () => {
  assert.equal(cliBaseUrl({ advertisedUrl: 'https://wisp.example.com/some/path', protocol: 'http', host: 'tini.local:8080' }), 'https://wisp.example.com');
  assert.equal(cliBaseUrl({ advertisedUrl: null, protocol: 'http', host: 'tini.local:8080' }), 'http://tini.local:8080');
  assert.equal(cliBaseUrl({ advertisedUrl: null, protocol: 'https', host: '192.168.1.5' }), 'https://192.168.1.5');
});

test('no address, or one a script could not carry, is none', () => {
  assert.equal(cliBaseUrl({ advertisedUrl: null, protocol: 'http', host: undefined }), null);
  assert.equal(cliBaseUrl({ advertisedUrl: null, protocol: 'http', host: "a'b" }), null);
  assert.equal(cliBaseUrl({ advertisedUrl: null, protocol: 'http', host: 'a b' }), null);
});

test('a script is never served without an address it can carry', () => {
  assert.throws(() => cliInstallScript('install.sh', null), { code: 'BAD_REQUEST' });
  assert.throws(() => cliInstallScript('install.ps1', "http://x'"), { code: 'BAD_REQUEST' });
});
