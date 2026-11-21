import { keyTaken, withRow, withoutRow } from '../appConfigRows.js';

/**
 * The Jellyfin app's config as its groups edit it, pure: media libraries (each a
 * storage mount at `/media/<label>`), the published address, and the GPU switch. It
 * holds no secret.
 */

const RESERVED_LABELS = new Set(['config', 'cache']);
const libraryKey = (lib) => lib.label;

/** The config as the PATCH takes it. */
export function jellyfinSendable(ac = {}) {
  return {
    libraries: (ac.libraries ?? []).filter(Boolean).map((l) => ({ label: l.label ?? '', sourceId: l.sourceId ?? '', subPath: l.subPath ?? '' })),
    gpuEnabled: ac.gpuEnabled === true,
    publishedUrl: ac.publishedUrl ?? '',
  };
}

export const libraryForm = (lib) => ({ label: lib?.label ?? '', sourceId: lib?.sourceId ?? '', subPath: lib?.subPath ?? '' });

export function withLibrary(ac, key, form) {
  const base = jellyfinSendable(ac);
  const lib = { label: form.label.trim(), sourceId: form.sourceId, subPath: form.subPath.trim() };
  return { ...base, libraries: withRow(base.libraries, libraryKey, key, lib) };
}

export function withoutLibrary(ac, key) {
  const base = jellyfinSendable(ac);
  return { ...base, libraries: withoutRow(base.libraries, libraryKey, key) };
}

/** Why the library cannot be saved, by field (none: an empty object). */
export function libraryProblems(ac, key, form) {
  const problems = {};
  const label = form.label.trim();
  if (!label) problems.label = 'A label is required.';
  else if (label.includes('/') || label.includes('\\') || label.includes('..') || label.startsWith('.')) {
    problems.label = 'No slashes, leading dots or "..".';
  } else if (RESERVED_LABELS.has(label)) problems.label = `"${label}" is reserved.`;
  else if (keyTaken(jellyfinSendable(ac).libraries, libraryKey, label, key)) problems.label = `A library is labelled ${label} already.`;
  if (!form.sourceId) problems.sourceId = 'Pick the storage that holds the media.';
  const sub = form.subPath.trim();
  if (sub.startsWith('/') || sub.split('/').some((seg) => seg === '..' || seg === '.')) {
    problems.subPath = 'A sub-path is relative, without "." or ".." parts.';
  }
  return problems;
}

export const withPublishedUrl = (ac, publishedUrl) => ({ ...jellyfinSendable(ac), publishedUrl: publishedUrl.trim() });

export const withGpu = (ac, on) => ({ ...jellyfinSendable(ac), gpuEnabled: on });
