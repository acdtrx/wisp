import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { createAppError } from './routeErrors.js';
import { getRawApiTokens, withSettingsWriteLock } from './settings.js';

export const API_TOKEN_SCOPES = ['read', 'admin'];
const TOKEN_RANDOM_BYTES = 32;
const LABEL_MAX_LENGTH = 64;

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Tokens listed for the UI — never includes the hash.
 */
export async function listApiTokens() {
  const stored = await getRawApiTokens();
  return stored.map((t) => ({ id: t.id, label: t.label, scope: t.scope, createdAt: t.createdAt }));
}

/**
 * Mint a new token. The plaintext is returned exactly once and never stored —
 * only its SHA-256 hash lands in wisp-config.json. The scope embedded in the
 * token prefix is cosmetic (readability in agent configs); the stored record
 * is authoritative.
 */
export async function createApiToken(label, scope) {
  const trimmed = typeof label === 'string' ? label.trim() : '';
  if (!trimmed || trimmed.length > LABEL_MAX_LENGTH) {
    throw createAppError('TOKEN_INVALID', `Token label must be 1-${LABEL_MAX_LENGTH} characters`);
  }
  if (!API_TOKEN_SCOPES.includes(scope)) {
    throw createAppError('TOKEN_INVALID', 'Token scope must be "read" or "admin"');
  }
  const token = `wisp_${scope}_${randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`;
  const entry = {
    id: randomUUID(),
    label: trimmed,
    scope,
    tokenHash: hashToken(token),
    createdAt: new Date().toISOString(),
  };
  await withSettingsWriteLock((fromFile) => ({
    ...fromFile,
    apiTokens: [...(fromFile.apiTokens || []), entry],
  }));
  return { id: entry.id, label: entry.label, scope: entry.scope, createdAt: entry.createdAt, token };
}

export async function revokeApiToken(id) {
  await withSettingsWriteLock((fromFile) => {
    const existing = fromFile.apiTokens || [];
    const next = existing.filter((t) => t.id !== id);
    if (next.length === existing.length) {
      throw createAppError('TOKEN_NOT_FOUND', `No API token with id "${id}"`);
    }
    return { ...fromFile, apiTokens: next };
  });
}

/**
 * Verify a presented bearer token. Returns { id, label, scope } or null.
 * Comparison is constant-time per entry and the whole list is always scanned,
 * so a miss and a hit do uniform work — the list is single-user scale.
 */
export async function verifyApiToken(token) {
  if (typeof token !== 'string' || !token.startsWith('wisp_')) return null;
  const presented = Buffer.from(hashToken(token), 'hex');
  const stored = await getRawApiTokens();
  let match = null;
  for (const t of stored) {
    const candidate = Buffer.from(t.tokenHash, 'hex');
    if (candidate.length === presented.length && timingSafeEqual(candidate, presented)) {
      match = t;
    }
  }
  return match ? { id: match.id, label: match.label, scope: match.scope } : null;
}
