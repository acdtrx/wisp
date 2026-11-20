/**
 * Pure VM manager helpers (no libvirt/DBus). Shared by linux and darwin implementations.
 */
import { randomBytes } from 'node:crypto';

/** Set by every Wisp error factory (lib/appErrors.js, which this manager cannot import). */
const WISP_ERROR = Symbol.for('wisp.error');

export function vmError(code, message, raw) {
  const err = new Error(message);
  err.code = code;
  if (raw) err.raw = raw;
  Object.defineProperty(err, WISP_ERROR, { value: true });
  return err;
}

/**
 * The error that says `message` about the failures `inners` — the manager's
 * twin of lib/appErrors.js's wrapAppError (docs/specs/ERROR-HANDLING.md → The
 * error body): a Wisp error's message joins the outer message whole and its
 * raw cause is the raw cause; any other error's text is all cause.
 */
export function wrapVmError(code, message, ...inners) {
  const messages = [];
  const raws = [];
  for (const inner of inners) {
    if (inner?.[WISP_ERROR] === true) {
      messages.push(inner.message);
      if (inner.raw) raws.push(inner.raw);
    } else {
      raws.push(inner?.message || String(inner));
    }
  }
  return vmError(code, messages.length ? `${message}: ${messages.join('; ')}` : message, raws.join('; '));
}

export function unwrapVariant(v) {
  while (v && typeof v === 'object' && 'signature' in v && 'value' in v) {
    v = v.value;
  }
  return v;
}

export function unwrapDict(d) {
  if (!d || typeof d !== 'object') return {};
  const result = {};
  if (Array.isArray(d)) {
    for (const entry of d) {
      if (Array.isArray(entry) && entry.length >= 2) {
        result[entry[0]] = unwrapVariant(entry[1]);
      }
    }
  } else {
    for (const [k, v] of Object.entries(d)) {
      result[k] = unwrapVariant(v);
    }
  }
  return result;
}

export function formatVersion(num) {
  num = Number(num);
  const major = Math.floor(num / 1000000);
  const minor = Math.floor((num % 1000000) / 1000);
  const micro = num % 1000;
  return `${major}.${minor}.${micro}`;
}

export function generateMAC() {
  const b = randomBytes(3);
  return `52:54:00:${b[0].toString(16).padStart(2, '0')}:${b[1].toString(16).padStart(2, '0')}:${b[2].toString(16).padStart(2, '0')}`;
}
