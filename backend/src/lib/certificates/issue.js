/**
 * Getting one certificate for a domain and its wildcard, step by step
 * (docs/specs/CERTIFICATES.md, The job): the account, the order, the DNS
 * challenge's TXT records through Cloudflare, the authority's validation, the
 * finalization. It stores nothing: the caller keeps the account, the records
 * still to remove and the certificate.
 */
import { X509Certificate } from 'node:crypto';

import { createAppError, wrapAppError } from '../appErrors.js';
import { openAcmeAccount, newEcKey } from './acme.js';
import { createTxtRecord, deleteTxtRecord, findZone } from './cloudflare.js';
import { waitForTxtRecords } from './challengeDns.js';
import { buildSigningRequest } from './signingRequest.js';

/** Removing a record after the job ends, however it ended, a shutdown's cut included. */
const CLEANUP_TIMEOUT_MS = 8_000;

/** The certificates of a PEM chain, in order. */
function pemBlocks(chain) {
  return chain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

/** `{ validFrom, validUntil, serial }` of a chain's leaf, ISO dates. */
export function describeChain(chain) {
  const [leaf] = pemBlocks(chain);
  if (!leaf) throw createAppError('CERTIFICATE_ISSUE_FAILED', 'The chain holds no certificate');
  const cert = new X509Certificate(leaf);
  return {
    validFrom: cert.validFromDate.toISOString(),
    validUntil: cert.validToDate.toISOString(),
    serial: cert.serialNumber,
  };
}

/**
 * Remove the TXT records `records` (`[{ zoneId, recordId }]`) with `token`.
 * Resolves the records that could not be removed, for the next job.
 */
export async function removeTxtRecords(token, records) {
  const left = [];
  for (const record of records) {
    try {
      await deleteTxtRecord(token, record.zoneId, record.recordId, { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });
    } catch {
      left.push(record); // kept for the next job, which removes it first
    }
  }
  return left;
}

/**
 * Get a certificate for `domain` and `*.<domain>`.
 *
 * - `account`: the stored account (`{ directory, url, key }`) or null; a new
 *   one is registered when it is not this directory's. `onAccount(account)` is
 *   called with the account to keep before anything else is ordered.
 * - `onStep(step)`: each step as it begins (`account`, `order`, `dns`,
 *   `validate`, `finalize`).
 * - `onRecords(records)`: the TXT records written and not yet removed, after
 *   every change, so a cut job's records can be removed by the next.
 *
 * Resolves `{ chain, key, validFrom, validUntil, serial }`, the key a PKCS#8
 * PEM. A failure is CERTIFICATE_ISSUE_FAILED naming the step, its cause the
 * authority's or Cloudflare's message; `signal` aborting rejects with its
 * reason. The records are removed when it ends, however it ends.
 */
export async function issueCertificate({ domain, token, directoryUrl, account, onAccount, onStep, onRecords, signal }) {
  let step = null;
  const enter = (name) => {
    step = name;
    onStep(name);
  };
  let records = [];

  try {
    enter('account');
    const opened = await openAcmeAccount({ directoryUrl, account, signal });
    await onAccount(opened.account);
    const acme = opened.client;

    enter('order');
    const { url: orderUrl, order } = await acme.newOrder([domain, `*.${domain}`]);
    const authorizations = [];
    for (const url of order.authorizations) {
      const authorization = await acme.getAuthorization(url);
      if (authorization?.status === 'valid') continue;
      const challenge = Array.isArray(authorization?.challenges)
        ? authorization.challenges.find((c) => c?.type === 'dns-01')
        : null;
      if (authorization?.status !== 'pending' || !challenge?.url || !challenge.token) {
        throw createAppError(
          'CERTIFICATE_ISSUE_FAILED',
          `The authorization for ${authorization?.identifier?.value ?? domain} is ${authorization?.status ?? 'unreadable'}, with no DNS challenge to answer`,
        );
      }
      authorizations.push({ url, challenge, value: acme.dnsChallengeValue(challenge.token) });
    }

    if (authorizations.length > 0) {
      enter('dns');
      const zone = await findZone(domain, token, { signal });
      const name = `_acme-challenge.${domain}`;
      for (const { value } of authorizations) {
        const recordId = await createTxtRecord(token, zone.id, name, value, { signal });
        records = [...records, { zoneId: zone.id, recordId }];
        await onRecords(records);
      }
      await waitForTxtRecords({ name, values: authorizations.map((a) => a.value), nameServers: zone.nameServers, signal });

      enter('validate');
      for (const { url, challenge } of authorizations) {
        await acme.answerChallenge(challenge.url);
        const settled = await acme.waitForAuthorization(url);
        if (settled?.status !== 'valid') {
          const failed = Array.isArray(settled?.challenges) ? settled.challenges.find((c) => c?.error) : null;
          const why = failed?.error ? [failed.error.type, failed.error.detail].filter(Boolean).join(': ') : settled?.status;
          throw createAppError('CERTIFICATE_ISSUE_FAILED', `The certificate authority did not validate ${settled?.identifier?.value ?? domain}`, why);
        }
      }
    }

    const ready = await acme.waitForOrderReady(orderUrl);
    if (ready?.status !== 'ready' && ready?.status !== 'valid') {
      throw createAppError('CERTIFICATE_ISSUE_FAILED', `The order is ${ready?.status ?? 'unreadable'}, not ready to finalize`);
    }

    enter('finalize');
    const certKey = newEcKey();
    const keyPem = certKey.export({ type: 'pkcs8', format: 'pem' });
    let issued = ready;
    if (ready.status === 'ready') {
      const csr = await buildSigningRequest(domain, keyPem);
      await acme.finalize(ready.finalize, csr);
      issued = await acme.waitForOrderIssued(orderUrl);
    }
    if (issued?.status !== 'valid' || !issued.certificate) {
      throw createAppError('CERTIFICATE_ISSUE_FAILED', `The order ended ${issued?.status ?? 'unreadable'}, with no certificate`);
    }
    const chain = await acme.downloadChain(issued.certificate);
    const leaf = new X509Certificate(pemBlocks(chain)[0]);
    if (!leaf.checkPrivateKey(certKey)) {
      throw createAppError('CERTIFICATE_ISSUE_FAILED', 'The certificate delivered is not for the key Wisp sent');
    }
    return { chain, key: keyPem, ...describeChain(chain) };
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err;
    throw wrapAppError('CERTIFICATE_ISSUE_FAILED', `The certificate could not be got, at the step "${step}"`, err);
  } finally {
    if (records.length > 0) {
      const left = await removeTxtRecords(token, records);
      await onRecords(left);
    }
  }
}
