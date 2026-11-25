/**
 * What Wisp obtained for the host's certificate (docs/specs/CERTIFICATES.md,
 * Where it is stored): `certificate.json` beside wisp-config.json, `0600`,
 * one record written atomically — the certificate authority account, the
 * chain and its key, the dates, the last attempt and the TXT records still to
 * remove. lib/hostCertificate.js writes it; the app containers' saves read
 * the certificate from here.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CONFIG_PATH } from './config.js';
import { writeJsonAtomic } from './base/index.js';

const STORE_PATH = join(dirname(CONFIG_PATH), 'certificate.json');

function emptyStore() {
  return { account: null, certificate: null, lastAttempt: null, txtRecords: [] };
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function storeInvalid(where) {
  return new Error(`certificate.json → ${where}: not what Wisp writes`);
}

function onlyKeys(obj, keys, where) {
  if (!isObject(obj)) throw storeInvalid(where);
  for (const key of Object.keys(obj)) if (!keys.includes(key)) throw storeInvalid(`${where}.${key}`);
}

function strings(obj, keys, where) {
  for (const key of keys) if (typeof obj[key] !== 'string' || !obj[key]) throw storeInvalid(`${where}.${key}`);
}

/** The file read strictly (CODING-RULES §4): only what this module writes. */
function parseStore(data) {
  onlyKeys(data, ['account', 'certificate', 'lastAttempt', 'txtRecords'], 'the file');
  const out = emptyStore();
  if (data.account != null) {
    onlyKeys(data.account, ['directory', 'url', 'key'], 'account');
    strings(data.account, ['directory', 'url'], 'account');
    if (!isObject(data.account.key)) throw storeInvalid('account.key');
    out.account = data.account;
  }
  if (data.certificate != null) {
    onlyKeys(data.certificate, ['domain', 'chain', 'key', 'validFrom', 'validUntil'], 'certificate');
    strings(data.certificate, ['domain', 'chain', 'key', 'validFrom', 'validUntil'], 'certificate');
    out.certificate = data.certificate;
  }
  if (data.lastAttempt != null) {
    onlyKeys(data.lastAttempt, ['at', 'error'], 'lastAttempt');
    strings(data.lastAttempt, ['at'], 'lastAttempt');
    if (data.lastAttempt.error !== null) {
      onlyKeys(data.lastAttempt.error, ['error', 'detail'], 'lastAttempt.error');
      strings(data.lastAttempt.error, ['error', 'detail'], 'lastAttempt.error');
    }
    out.lastAttempt = data.lastAttempt;
  }
  if (!Array.isArray(data.txtRecords)) throw storeInvalid('txtRecords');
  out.txtRecords = data.txtRecords.map((r, i) => {
    onlyKeys(r, ['zoneId', 'recordId'], `txtRecords[${i}]`);
    strings(r, ['zoneId', 'recordId'], `txtRecords[${i}]`);
    return r;
  });
  return out;
}

/** The store as last read or written: only this module writes it. */
let cached = null;

export async function readStore() {
  if (cached) return cached;
  let raw;
  try {
    raw = await readFile(STORE_PATH, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    cached = emptyStore();
    return cached;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`certificate.json: not JSON (${err.message})`);
  }
  cached = parseStore(data);
  return cached;
}

/**
 * The start's strict read of the file (CODING-RULES §4), with the other stored
 * config: one that is not what Wisp writes stops the start, naming it, rather
 * than failing every read later (the stats topic among them). Once read, only
 * this module's writes change it.
 */
export async function checkCertificateStore() {
  await readStore();
}

let storeLock = Promise.resolve();

/**
 * Write the store through `mutate(current) → next`, one write at a time,
 * atomically and `0600` (it holds the account's and the certificate's keys).
 */
export function updateStore(mutate) {
  const run = storeLock.then(async () => {
    const next = await mutate(await readStore());
    if (!next) return;
    await writeJsonAtomic(STORE_PATH, next, { mode: 0o600 });
    cached = next;
  });
  storeLock = run.catch(() => { /* the rejection is the caller's (run), not the chain's */ });
  return run;
}

/**
 * The certificate Wisp holds, as an app container gets it — `{ domain, chain,
 * key }`, PEM text — or null when it holds none.
 */
export async function getHeldCertificate() {
  const { certificate } = await readStore();
  return certificate ? { domain: certificate.domain, chain: certificate.chain, key: certificate.key } : null;
}

/** The certificate Wisp holds without its key or chain — `{ domain, validUntil }` — or null. */
export async function getHeldCertificateSummary() {
  const { certificate } = await readStore();
  return certificate ? { domain: certificate.domain, validUntil: certificate.validUntil } : null;
}
