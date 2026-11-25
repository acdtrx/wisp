/**
 * The certificate signing request (PKCS#10) for a domain and its wildcard.
 * Node's crypto cannot build one, so `openssl req` does (CODING-RULES §7, the
 * exec allowlist): the key goes in on stdin, never as an argument or a file,
 * and the request comes back on stdout as DER.
 */
import { spawn } from 'node:child_process';

import { createAppError } from '../appErrors.js';

/** One short local computation. */
const OPENSSL_TIMEOUT_MS = 15_000;

/**
 * The DER request for `<domain>` and `*.<domain>`, signed with `keyPem` (a
 * PKCS#8 PEM private key). `domain` must already be checked: it becomes the
 * subject and the alternative names, as arguments, with no shell between.
 * @returns {Promise<Buffer>}
 */
export function buildSigningRequest(domain, keyPem) {
  const args = [
    'req', '-new', '-key', '/dev/stdin', '-subj', `/CN=${domain}`,
    '-addext', `subjectAltName=DNS:${domain},DNS:*.${domain}`, '-outform', 'DER',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('openssl', args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: OPENSSL_TIMEOUT_MS });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (e) => reject(createAppError('CERTIFICATE_ISSUE_FAILED', 'openssl could not be run', e.message)));
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(out));
        return;
      }
      const why = signal ? `stopped by ${signal}` : Buffer.concat(err).toString('utf8').trim() || `exit ${code}`;
      reject(createAppError('CERTIFICATE_ISSUE_FAILED', 'openssl could not build the signing request', why));
    });
    child.stdin.on('error', () => { /* openssl exited before reading the key: its close reports why */ });
    child.stdin.end(keyPem);
  });
}
