import { getToken, clearToken } from './client.js';

/**
 * POST a single file as multipart field `file` with optional upload progress (0–100).
 * Parses JSON success body; on failure sets `err.detail` from server when present.
 */
export function postMultipartFile(url, file, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : undefined;

  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);

    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      });
    }

    xhr.addEventListener('load', () => {
      if (xhr.status === 401) {
        clearToken();
        window.location.href = '/login';
        reject(new Error('Session expired'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText || '{}'));
        } catch {
          /* Response body not JSON — treat as empty success payload */
          resolve({});
        }
        return;
      }
      let msg = `Upload failed (${xhr.status})`;
      let detail;
      try {
        const data = JSON.parse(xhr.responseText || '{}');
        if (data.error) msg = data.error;
        detail = data.detail;
      } catch {
        /* Error body not JSON — use HTTP status text */
        msg = xhr.statusText || msg;
      }
      const err = new Error(msg);
      if (detail) err.detail = detail;
      reject(err);
    });

    xhr.addEventListener('error', () => reject(new Error('Upload failed')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

    xhr.send(formData);
  });
}
