/**
 * SSH public keys: what one is, when two are the same key, and the name a key takes
 * when none is given (docs/specs/SETTINGS.md, SSH keys). Wisp's list of keys lives in
 * the settings file (lib/settings.js, read through configSchema.js); a VM keeps its own
 * copy of the keys it was given (its first boot setup's `sshKey`).
 */
import { createHash } from 'node:crypto';

import { createAppError } from './appErrors.js';

/*
 * The fields of a public key's blob after its type name (RFC 4253 §6.6, RFC 5656 §3.1,
 * RFC 8709 §4, OpenSSH's PROTOCOL.u2f), each a length-prefixed string: an ed25519 key
 * (32 bytes), an RSA exponent and modulus, an ECDSA curve name and point (uncompressed:
 * 0x04, then both coordinates), and a security key's application string.
 */
const ED25519 = { kind: 'bytes', size: 32 };
const point = (curve, size) => [{ kind: 'equals', value: curve }, { kind: 'point', size }];
const APPLICATION = { kind: 'text' };

/** The key types Wisp takes: the short name the page shows, and the blob's fields. */
const KEY_TYPES = new Map([
  ['ssh-ed25519', { name: 'ed25519', fields: [ED25519] }],
  ['ssh-rsa', { name: 'rsa', fields: [{ kind: 'mpint' }, { kind: 'mpint', minBits: 1024 }] }],
  ['ecdsa-sha2-nistp256', { name: 'ecdsa', fields: point('nistp256', 65) }],
  ['ecdsa-sha2-nistp384', { name: 'ecdsa', fields: point('nistp384', 97) }],
  ['ecdsa-sha2-nistp521', { name: 'ecdsa', fields: point('nistp521', 133) }],
  ['sk-ssh-ed25519@openssh.com', { name: 'ed25519-sk', fields: [ED25519, APPLICATION] }],
  ['sk-ecdsa-sha2-nistp256@openssh.com', { name: 'ecdsa-sk', fields: [...point('nistp256', 65), APPLICATION] }],
]);

const ONE_KEY_A_LINE = 'One key at a time: paste a single key.';

/** A public key is one line well under this; a longer text is no key. */
export const MAX_SSH_KEY_LENGTH = 8192;
/** A key's name: what the page shows for it. */
export const MAX_SSH_KEY_NAME = 64;
/** The list's length: far past anyone's keys, and a bound on the file. */
export const MAX_SSH_KEYS = 100;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** One field of the blob: its length-prefixed bytes at `at`, or null past the end. */
function stringAt(blob, at) {
  if (at + 4 > blob.length) return null;
  const length = blob.readUInt32BE(at);
  if (at + 4 + length > blob.length) return null;
  return { bytes: blob.subarray(at + 4, at + 4 + length), next: at + 4 + length };
}

/** Whether a field's bytes are what the type has there. */
function fieldFits(field, bytes) {
  switch (field.kind) {
    case 'bytes': return bytes.length === field.size;
    case 'equals': return bytes.toString('latin1') === field.value;
    case 'point': return bytes.length === field.size && bytes[0] === 0x04;
    case 'text': return bytes.length > 0;
    case 'mpint': {
      // Positive, with no needless leading zero byte, and at least minBits wide.
      if (bytes.length === 0 || bytes[0] & 0x80) return false;
      if (bytes[0] === 0 && (bytes.length === 1 || !(bytes[1] & 0x80))) return false;
      const digits = bytes[0] === 0 ? bytes.subarray(1) : bytes;
      const bits = digits.length * 8 - Math.clz32(digits[0]) + 24;
      return bits >= (field.minBits ?? 1);
    }
    default: return false;
  }
}

/** Whether the blob is a whole key of its type: its name, each field, and nothing after. */
function blobFits(blob, type) {
  const head = stringAt(blob, 0);
  if (!head || head.bytes.toString('latin1') !== type) return false;
  let at = head.next;
  for (const field of KEY_TYPES.get(type).fields) {
    const got = stringAt(blob, at);
    if (!got || !fieldFits(field, got.bytes)) return false;
    at = got.next;
  }
  return at === blob.length;
}
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
  if (/[\r\n]/.test(trimmed)) return { problem: ONE_KEY_A_LINE };
  if (trimmed.length > MAX_SSH_KEY_LENGTH) return { problem: 'That is too long for an SSH public key.' };
  const [type, base64, ...rest] = trimmed.split(/\s+/);
  if (!KEY_TYPES.has(type)) return { problem: `"${type.slice(0, 40)}" is not an SSH key type Wisp takes.` };
  if (!base64 || !BASE64.test(base64)) return { problem: 'The key’s data is not base64.' };
  const blob = Buffer.from(base64, 'base64');
  // Canonical: one key has one text, so a re-padded copy is still the same key.
  if (blob.toString('base64') !== base64) return { problem: 'The key’s data is not plain base64: it may be cut short.' };
  if (!blobFits(blob, type)) return { problem: 'The key’s data is not a whole key of its type: it may be cut short.' };
  if (rest.some((word) => KEY_TYPES.has(word))) return { problem: ONE_KEY_A_LINE };
  const comment = rest.join(' ');
  if (CONTROL.test(comment)) return { problem: 'The key’s comment holds a control character.' };
  const identity = `${type} ${base64}`;
  return { key: comment ? `${identity} ${comment}` : identity, type: KEY_TYPES.get(type).name, identity, comment, blob };
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
