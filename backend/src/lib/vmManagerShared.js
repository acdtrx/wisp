/**
 * Pure VM manager helpers (no libvirt/DBus). Shared by linux and darwin implementations.
 */
import { randomBytes } from 'node:crypto';

export function vmError(code, message, raw) {
  const err = new Error(message);
  err.code = code;
  if (raw) err.raw = raw;
  return err;
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
