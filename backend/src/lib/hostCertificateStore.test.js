/*
 * certificate.json's strict read, on a temporary config folder (WISP_CONFIG_PATH,
 * set before the module loads): a file that is not what Wisp writes is refused,
 * naming the file, as the start's check reports it.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-certificate-store-test-'));
process.env.WISP_CONFIG_PATH = path.join(dir, 'wisp-config.json');
after(() => rmSync(dir, { recursive: true, force: true }));
const storeFile = path.join(dir, 'certificate.json');

// The store keeps a file it read; one it refused leaves nothing kept, so the cases run in this order.
const { checkCertificateStore: freshCheck } = await import('./hostCertificateStore.js');

test('a file that is not what Wisp writes stops the check, naming it; one that is passes', async () => {
  writeFileSync(storeFile, '{ not json');
  await assert.rejects(freshCheck(), /certificate\.json: not JSON/);
  writeFileSync(storeFile, JSON.stringify({ account: null, certificate: null, lastAttempt: null, txtRecords: [], extra: 1 }));
  await assert.rejects(freshCheck(), /certificate\.json → the file\.extra/);
  writeFileSync(storeFile, JSON.stringify({ account: null, certificate: { domain: 'x' }, lastAttempt: null, txtRecords: [] }));
  await assert.rejects(freshCheck(), /certificate\.json → certificate/);
  writeFileSync(storeFile, JSON.stringify({ account: null, certificate: null, lastAttempt: null, txtRecords: [] }));
  await freshCheck();
});
