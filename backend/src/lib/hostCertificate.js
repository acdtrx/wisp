/**
 * The host's certificate (docs/specs/CERTIFICATES.md), app glue: the setting
 * and the checks a save runs, the job that gets the certificate, the record
 * the pages read, and what Wisp obtained (lib/hostCertificateStore.js).
 * lib/certificates speaks to the certificate authority and
 * Cloudflare; this module decides when, and keeps what they gave.
 */
import { checkCertificateDomain } from './configSchema.js';
import { getRawCertificateSetting, writeCertificateSetting } from './settings.js';
import { createAppError, errorBody } from './appErrors.js';
import { createEmitter } from './base/index.js';
import { readStore, updateStore } from './hostCertificateStore.js';
import { findZone, issueCertificate, removeTxtRecords } from './certificates/index.js';
import { startJob, titleForCertificateIssue, whenJobEnds } from './jobs/index.js';
import { getContainerConfig, listContainers } from './containerManager/index.js';
import { usesHostCertificate } from './containerApps/index.js';
import { deliverHostCertificate } from './containerOperations.js';
import { log } from './log.js';
import { JOB_KIND } from '../../../shared/wireNames.js';

const LETS_ENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';

/** The directory Wisp gets certificates from: Let's Encrypt's, unless runtime.env names another. */
function acmeDirectory() {
  return process.env.WISP_ACME_DIRECTORY || LETS_ENCRYPT_DIRECTORY;
}

// ── the record ───────────────────────────────────────────────────────────────

/** Fired after every write of the setting and at the end of every attempt: a cue to read the record again. */
const certificateChange = createEmitter('certificate: change', log);

export const subscribeCertificateChange = certificateChange.subscribe;

/** When a renewal is due: two thirds of the certificate's own lifetime. */
function renewAt(validFrom, validUntil) {
  const from = Date.parse(validFrom);
  return new Date(from + ((Date.parse(validUntil) - from) * 2) / 3).toISOString();
}

/** The record the pages read (CERTIFICATES.md, The record): no secret in it. */
export async function getCertificateRecord() {
  const setting = await getRawCertificateSetting();
  const store = await readStore();
  const cert = store.certificate;
  return {
    domain: setting?.domain ?? null,
    tokenSet: !!setting?.cloudflareApiToken,
    certificate: cert
      ? { domain: cert.domain, validFrom: cert.validFrom, validUntil: cert.validUntil, renewAt: renewAt(cert.validFrom, cert.validUntil) }
      : null,
    lastAttempt: store.lastAttempt,
  };
}

/** Whether the last attempt failed: the host's flag (`certificateFailed` in the stats topic). */
export async function isCertificateFailed() {
  return (await readStore()).lastAttempt?.error != null;
}

// ── delivery ─────────────────────────────────────────────────────────────────

/**
 * Deliver the certificate Wisp holds (or none) to every app container that
 * uses it (CERTIFICATES.md, Delivery): each one's own config save. A busy
 * container is skipped and a failed save logged: the next check delivers to
 * both. `trigger` names what asked, for the log.
 */
export async function deliverToAppContainers(trigger, deliveryLog) {
  const names = [];
  for (const { name } of await listContainers()) {
    try {
      if (usesHostCertificate(await getContainerConfig(name))) names.push(name);
    } catch (err) {
      deliveryLog.warn({ container: name, code: err?.code, err: err?.message }, 'The host certificate could not be delivered: the container could not be read');
    }
  }
  const outcome = { delivered: [], skipped: [], failed: [] };
  for (const name of names) {
    try {
      const result = await deliverHostCertificate(name);
      if (result.delivered) {
        outcome.delivered.push(name);
        deliveryLog.info({ container: name, trigger, requiresRestart: result.requiresRestart, reloaded: result.reloaded === true }, 'The host certificate was delivered');
      } else {
        outcome.skipped.push(name);
        deliveryLog.info({ container: name, trigger }, 'The host certificate was not delivered: the container is busy; the next check delivers it');
      }
    } catch (err) {
      outcome.failed.push(name);
      deliveryLog.warn({ container: name, trigger, code: err?.code, err: err?.message, raw: err?.raw }, 'The host certificate could not be delivered; the next check tries again');
    }
  }
  return outcome;
}

// ── the job ──────────────────────────────────────────────────────────────────

/** The jobs whose end this module follows, so a joined start does not follow one twice. */
const followed = new Set();

/**
 * After a job for `domain` ended: a save that changed the domain while it ran
 * joined it (the job is shared), so the new domain gets its own job now.
 */
async function afterJob(domain, jobLog) {
  const setting = await getRawCertificateSetting();
  if (setting && setting.domain !== domain) await startIssueJob(setting, jobLog);
}

/**
 * Start the certificate job for `setting`, or join the one that runs.
 * Resolves its ack.
 */
async function startIssueJob(setting, jobLog) {
  const { domain, cloudflareApiToken: token } = setting;
  const ack = await startJob({
    kind: JOB_KIND.CERTIFICATE_ISSUE,
    title: titleForCertificateIssue(domain),
    shared: true,
    interruptible: true,
    log: jobLog,
    run: (report, signal) => runIssueJob({ domain, token, report, signal, jobLog }),
  });
  if (!followed.has(ack.jobId)) {
    followed.add(ack.jobId);
    whenJobEnds(ack.jobId).then(async (status) => {
      followed.delete(ack.jobId);
      if (status === 'cancelled') return; // a shutdown: the next start's check runs it again
      await afterJob(domain, jobLog);
    }).catch((err) => jobLog.warn({ err: err?.message, code: err?.code }, 'The certificate job for the changed domain was not started'));
  }
  return ack;
}

async function runIssueJob({ domain, token, report, signal, jobLog }) {
  const before = await readStore();
  let leftover = before.txtRecords;
  if (leftover.length > 0) {
    leftover = await removeTxtRecords(token, leftover);
    await updateStore((s) => ({ ...s, txtRecords: leftover }));
    jobLog.info({ removed: before.txtRecords.length - leftover.length, left: leftover.length }, 'Removed the TXT records an earlier certificate job left');
  }

  try {
    const issued = await issueCertificate({
      domain,
      token,
      directoryUrl: acmeDirectory(),
      account: before.account,
      onAccount: (account) => updateStore((s) => ({ ...s, account })),
      onStep: (step) => report({ step }),
      onRecords: (records) => updateStore((s) => ({ ...s, txtRecords: [...leftover, ...records] })),
      signal,
    });

    report({ step: 'deliver' });
    let stored = false;
    await updateStore(async (s) => {
      // Under the store's lock: a removal of the setting either lands before
      // this read, and nothing is stored, or clears what is stored after it.
      if (!(await getRawCertificateSetting())) return null;
      stored = true;
      return {
        ...s,
        certificate: { domain, chain: issued.chain, key: issued.key, validFrom: issued.validFrom, validUntil: issued.validUntil },
        lastAttempt: { at: new Date().toISOString(), error: null },
      };
    });
    if (!stored) {
      throw createAppError('CERTIFICATE_NOT_FOUND', 'The certificate setting was removed while its job ran');
    }
    certificateChange.emit();
    jobLog.info({ domain, validUntil: issued.validUntil, serial: issued.serial }, 'The host certificate was stored');
    // Stored, the job's work is done: a container that misses the delivery is
    // logged and gets it from the next check, never fails the job.
    await deliverToAppContainers('certificate job', jobLog).catch((err) => {
      jobLog.warn({ code: err?.code, err: err?.message }, 'The host certificate was not delivered: the containers could not be listed; the next check delivers it');
    });
    return { domain, validUntil: issued.validUntil };
  } catch (err) {
    if (!signal?.aborted && err?.code !== 'CERTIFICATE_NOT_FOUND') {
      await updateStore(async (s) => ((await getRawCertificateSetting())
        ? { ...s, lastAttempt: { at: new Date().toISOString(), error: errorBody(err) } }
        : null));
      certificateChange.emit();
    }
    throw err;
  }
}

/**
 * Renew now: start the job whatever the dates say, or answer the one that
 * runs. CERTIFICATE_NOT_FOUND with no setting.
 */
export async function startCertificateIssueJob(jobLog) {
  const setting = await getRawCertificateSetting();
  if (!setting) {
    throw createAppError(
      'CERTIFICATE_NOT_FOUND',
      'The host has no certificate setting to renew',
      'Set a domain and a Cloudflare token in Host → App Config → Certificate first',
    );
  }
  return startIssueJob(setting, jobLog);
}

// ── the setting ──────────────────────────────────────────────────────────────

/**
 * Save the setting (CERTIFICATES.md, The certificate setting): the domain's
 * form, then the zone Cloudflare holds for it with the token, before anything
 * is stored. An omitted or empty token keeps the stored one. A save starts the
 * job whenever Wisp holds no certificate for the saved domain (a first save, a
 * changed domain, a token corrected after a failed attempt); the route does
 * not wait.
 */
export async function saveCertificateSetting({ domain, cloudflareApiToken }, reqLog) {
  const checkedDomain = checkCertificateDomain(domain);
  const typed = typeof cloudflareApiToken === 'string' ? cloudflareApiToken.trim() : '';
  const token = typed || (await getRawCertificateSetting())?.cloudflareApiToken;
  if (!token) {
    throw createAppError('INVALID_SETTINGS', 'A Cloudflare API token is required', 'One that can read the zone and edit its DNS records');
  }
  await findZone(checkedDomain, token);

  const written = await writeCertificateSetting(() => ({ domain: checkedDomain, cloudflareApiToken: token }));
  certificateChange.emit();
  reqLog.info({ domain: checkedDomain, tokenChanged: !!typed }, 'The certificate setting was saved');
  if ((await readStore()).certificate?.domain === checkedDomain) return;
  try {
    await startIssueJob(written, reqLog);
  } catch (err) {
    // Stored all the same: the next check starts the job (CERTIFICATES.md, Renewal).
    reqLog.warn({ code: err?.code, err: err?.message }, 'The certificate job was not started after the save');
  }
}

/**
 * Remove the setting: its token, the certificate and its key. The records a
 * cut job left are removed first, while the token is still known. The account
 * is kept; nothing is revoked.
 */
export async function removeCertificateSetting(reqLog) {
  let removed = null;
  await writeCertificateSetting((current) => {
    removed = current;
    return null;
  });
  await updateStore(async (s) => {
    let left = s.txtRecords;
    if (removed && left.length > 0) left = await removeTxtRecords(removed.cloudflareApiToken, left);
    if (left.length > 0) reqLog.warn({ records: left.length }, 'TXT records a certificate job left stay in the zone: Cloudflare did not remove them');
    return { ...s, certificate: null, lastAttempt: null, txtRecords: [] };
  });
  certificateChange.emit();
  reqLog.info({ hadSetting: !!removed }, 'The certificate setting was removed');
  // The route answers once the setting is gone; the apps' saves run on.
  deliverToAppContainers('certificate removed', reqLog).catch((err) => {
    reqLog.warn({ code: err?.code, err: err?.message }, 'The removal was not delivered: the containers could not be listed; the next check delivers it');
  });
}
