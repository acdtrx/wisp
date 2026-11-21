/**
 * SSH public keys: what one is, when two are the same key, and the name a key takes
 * when none is given (docs/specs/SETTINGS.md, SSH keys). Wisp's list of keys lives in
 * the settings file (lib/settings.js, read through configSchema.js); a VM keeps its own
 * copy of the keys it was given (its first boot setup's `sshKey`).
 */
import { createHash } from 'node:crypto';

import { createAppError } from './appErrors.js';

/** The key types Wisp takes, each with the short name the page shows. */
const KEY_TYPES = new Map([
  ['ssh-ed25519', 'ed25519'],
  ['ssh-rsa', 'rsa'],
  ['ecdsa-sha2-nistp256', 'ecdsa'],
  ['ecdsa-sha2-nistp384', 'ecdsa'],
  ['ecdsa-sha2-nistp521', 'ecdsa'],
  ['sk-ssh-ed25519@openssh.com', 'ed25519-sk'],
  ['sk-ecdsa-sha2-nistp256@openssh.com', 'ecdsa-sk'],
]);

/** A public key is one line well under this; a longer text is no key. */
export const MAX_SSH_KEY_LENGTH = 8192;
/** A key's name: what the page shows for it. */
export const MAX_SSH_KEY_NAME = 64;
/** The list's length: far past anyone's keys, and a bound on the file. */
export const MAX_SSH_KEYS = 100;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The text as one SSH public key: `{ key, type, identity, comment }`, `key` the text
 * as stored (`<type> <base64>[ <comment>]`, spaces made single) and `identity` what two
 * copies of the same key share (type and base64); `{ problem }` when it is not one.
 */
export function readSshKey(text) {
  if (typeof text !== 'string' || !text.trim()) return { problem: 'Paste an SSH public key.' };
  const trimmed = text.trim();
  if (/^-----BEGIN /.test(trimmed) || /PRIVATE KEY/.test(trimmed)) {
    return { problem: 'That is a private key: paste the public one (.pub).' };
  }
  if (/[\r\n]/.test(trimmed)) return { problem: 'One key at a time: paste a single line.' };
  if (trimmed.length > MAX_SSH_KEY_LENGTH) return { problem: 'That is too long for an SSH public key.' };
  const [type, base64, ...rest] = trimmed.split(/\s+/);
  if (!KEY_TYPES.has(type)) return { problem: `"${type.slice(0, 40)}" is not an SSH key type Wisp takes.` };
  if (!base64 || !BASE64.test(base64)) return { problem: 'The key’s data is not base64.' };
  const blob = Buffer.from(base64, 'base64');
  const length = blob.length >= 4 ? blob.readUInt32BE(0) : -1;
  if (length < 0 || blob.length < 4 + length || blob.subarray(4, 4 + length).toString('latin1') !== type) {
    return { problem: 'The key’s data does not match its type.' };
  }
  const comment = rest.join(' ');
  if (CONTROL.test(comment)) return { problem: 'The key’s comment holds a control character.' };
  const identity = `${type} ${base64}`;
  return { key: comment ? `${identity} ${comment}` : identity, type: KEY_TYPES.get(type), identity, comment, blob };
}

/** Throw SSH_KEY_INVALID for text that is not one SSH public key; else what `readSshKey` read. */
export function parseSshKey(text) {
  const read = readSshKey(text);
  if (read.problem) throw createAppError('SSH_KEY_INVALID', read.problem);
  return read;
}

/** The key's fingerprint as `ssh-keygen -l` prints it. */
export function sshKeyFingerprint(read) {
  return `SHA256:${createHash('sha256').update(read.blob).digest('base64').replace(/=+$/, '')}`;
}

/** A key's name, trimmed, or null when it is no name (empty, too long, a control character). */
export function validSshKeyName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > MAX_SSH_KEY_NAME || CONTROL.test(name)) return null;
  return name;
}

/** The name a key takes when it is added without one: its comment, or one from its type. */
export function defaultSshKeyName(read) {
  return validSshKeyName(read.comment.slice(0, MAX_SSH_KEY_NAME)) ?? `SSH key (${read.type})`;
}
