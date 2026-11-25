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
/** Finding a name server's address: one local lookup. */
const LOOKUP_TIMEOUT_MS = 5_000;
const QUERY_TRIES = 2;
/** The zone's servers usually answer within seconds of the write. */
const TXT_WAIT_MS = 5 * 60_000;

/**
 * Settle with `promise`, or reject once `signal` aborts: for a lookup, which
 * takes no signal of its own and keeps running but no longer holds the job.
 */
function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** The addresses of the zone's name servers, IPv4 first; each lookup bounded, and cut by `signal`. */
async function nameServerAddresses(nameServers, signal) {
  const found = await Promise.all(nameServers.map(async (ns) => {
    const bound = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
    try {
      return await untilAborted(lookup(ns, { all: true }), signal ? AbortSignal.any([signal, bound]) : bound);
    } catch {
      if (signal?.aborted) throw signal.reason;
      return []; // a server that does not resolve in time is left out; none at all fails below
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
  const addresses = await nameServerAddresses(nameServers, signal);
  if (addresses.length === 0) {
    throw createAppError('CERTIFICATE_ISSUE_FAILED', "The zone's name servers could not be found", nameServers.join(', ') || 'Cloudflare named none');
  }
  const resolver = new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: QUERY_TRIES });
  resolver.setServers(addresses);
  // A cut job does not wait out a query in flight: cancelling ends it at once.
  const cancel = () => resolver.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await pollTxt({ resolver, name, values, signal });
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/** Look until every value shows, within TXT_WAIT_MS, waiting between looks. */
async function pollTxt({ resolver, name, values, signal }) {
  const deadline = Date.now() + TXT_WAIT_MS;
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    let seen;
    try {
      seen = await txtValues(resolver, name);
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
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
