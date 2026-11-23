/**
 * The forms a container mount's name and sub-path take: pure, so the macOS
 * stub and the app recipes check them the same way.
 */
import { basename } from 'node:path';

/**
 * @param {string} name
 * @returns {string|null} normalized segment or null if invalid
 */
export function validateMountSegmentName(name) {
  if (!name || typeof name !== 'string') return null;
  const t = name.trim();
  if (t.includes('/') || t.includes('\\') || t.includes('..')) return null;
  if (t.startsWith('.')) return null;
  if (t !== basename(t)) return null;
  return t;
}

/**
 * Validate a sub-path (relative, no `..`, no leading `/`). Empty string is allowed (means mount root).
 * @param {unknown} value
 * @returns {string|null} normalized sub-path (no leading/trailing slashes) or null if invalid
 */
export function validateSubPath(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed.startsWith('/')) return null;
  const segments = trimmed.split('/').filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return null;
  }
  return segments.join('/');
}
