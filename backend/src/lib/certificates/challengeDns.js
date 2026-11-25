/**
 * Waiting for the challenge's TXT records: asked of the zone's own name
 * servers, so the certificate authority is told to look only once the zone
 * answers with them. DNS, not HTTP: Node's resolver, aimed at those servers.
 */
import { lookup, Resolver } from 'node:dns/promises';

import { createAppError } from '../appErrors.js';
import { waitBetweenTries } from './waiting.js';

/** One query: 5 s per try, two tries, before the next poll. */
const QUERY_TIMEOUT_MS = 5_000;
const QUERY_TRIES = 2;
/** The zone's servers usually answer within seconds of the write. */
const TXT_WAIT_MS = 5 * 60_000;

/** The addresses of the zone's name servers, IPv4 first. */
async function nameServerAddresses(nameServers) {
  const found = await Promise.all(nameServers.map(async (ns) => {
    try {
      return await lookup(ns, { all: true });
    } catch {
      return []; // a server that does not resolve is left out; none at all fails below
    }
  }));
  return found.flat().sort((a, b) => a.family - b.family).map((a) => a.address);
}

/** The TXT strings `name` has on the resolver's servers now; none yet is empty. */
async function txtValues(resolver, name) {
  try {
    const records = await resolver.resolveTxt(name);
    return new Set(records.map((chunks) => chunks.join('')));
  } catch (err) {
    if (err?.code === 'ENODATA' || err?.code === 'ENOTFOUND') return new Set();
    throw err;
  }
}

/**
 * Resolve once the zone's name servers answer `name` with every one of
 * `values`. Throws CERTIFICATE_ISSUE_FAILED when the servers cannot be found,
 * or the records do not show within the wait. `signal` aborting rejects with
 * its reason.
 */
export async function waitForTxtRecords({ name, values, nameServers, signal }) {
  const addresses = await nameServerAddresses(nameServers);
  if (addresses.length === 0) {
    throw createAppError('CERTIFICATE_ISSUE_FAILED', "The zone's name servers could not be found", nameServers.join(', ') || 'Cloudflare named none');
  }
  const resolver = new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: QUERY_TRIES });
  resolver.setServers(addresses);
  const deadline = Date.now() + TXT_WAIT_MS;
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    let seen;
    try {
      seen = await txtValues(resolver, name);
    } catch (err) {
      seen = new Set(); // a server timing out now may answer at the next poll
      if (Date.now() >= deadline) throw createAppError('CERTIFICATE_ISSUE_FAILED', `The zone's name servers did not answer for ${name}`, err.message);
    }
    if (values.every((v) => seen.has(v))) return;
    if (Date.now() >= deadline) {
      throw createAppError('CERTIFICATE_ISSUE_FAILED', `The zone's name servers did not show the TXT records at ${name} within ${TXT_WAIT_MS / 60_000} minutes`);
    }
    await waitBetweenTries(attempt, null, deadline, signal);
  }
}
