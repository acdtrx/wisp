import { api } from './client.js';
import { postMultipartFile } from './upload.js';

export async function listFiles(type) {
  const params = type ? `?type=${encodeURIComponent(type)}` : '';
  return api(`/api/library${params}`);
}

/** Answers 204: the list follows on the `library` cue (also rename and upload). */
export async function deleteFile(filename) {
  return api(`/api/library/${encodeURIComponent(filename)}`, { method: 'DELETE' });
}

export async function renameFile(filename, newName) {
  return api(`/api/library/${encodeURIComponent(filename)}`, {
    method: 'PATCH',
    body: { name: newName },
  });
}

export async function checkDownloadUrl(url) {
  const params = new URLSearchParams({ url });
  return api(`/api/library/check-url?${params}`);
}

/** A job: answers 202 `{ jobId, kind, title, subject }` (all four downloads). */
export async function startDownloadFromUrl(url) {
  return api('/api/library/download', { method: 'POST', body: { url } });
}

export async function startDownloadUbuntuCloud() {
  return api('/api/library/download-ubuntu-cloud', { method: 'POST' });
}

export async function startDownloadHaos() {
  return api('/api/library/download-haos', { method: 'POST' });
}

export async function startDownloadArchCloud() {
  return api('/api/library/download-arch-cloud', { method: 'POST' });
}

export function uploadFile(file, onProgress) {
  return postMultipartFile('/api/library/upload', file, { onProgress });
}
