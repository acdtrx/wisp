import { API_TIMEOUT_MS, leaveForLogin, readCsrfToken } from './client.js';
import { ApiError, errorFromBody, isSessionLost } from './errors.js';

/*
 * CODING-RULES §6: no total cap while sending — a large file on a slow link
 * takes as long as it takes — but 60 s without upload progress aborts it. Once
 * the body is sent, the reply is a short request (API_TIMEOUT_MS): what can
 * take longer, such as extracting an uploaded zip, is a job the reply names.
 */
const UPLOAD_IDLE_MS = 60_000;
const REPLY_TIMEOUT_MS = API_TIMEOUT_MS;

/**
 * POST a single file as multipart field `file` with optional upload progress (0–100).
 * Parses JSON success body; fails with an ApiError, as `api()` does.
 */
export function postMultipartFile(url, file, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : undefined;

  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    const csrf = readCsrfToken();
    if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);

    let stalled = false;
    let replyTimedOut = false;
    let idleTimer = null;
    let replyTimer = null;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, UPLOAD_IDLE_MS);
    };
    xhr.upload.addEventListener('progress', (e) => {
      armIdle();
      if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    // Body sent: the idle watch ends, the reply deadline starts (its own timer:
    // xhr.timeout counts from send(), so it would include the upload itself).
    xhr.upload.addEventListener('load', () => {
      clearTimeout(idleTimer);
      replyTimer = setTimeout(() => {
        replyTimedOut = true;
        xhr.abort();
      }, REPLY_TIMEOUT_MS);
    });
    xhr.addEventListener('loadend', () => {
      clearTimeout(idleTimer);
      clearTimeout(replyTimer);
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText || '{}'));
        } catch {
          /* Response body not JSON — treat as empty success payload */
          resolve({});
        }
        return;
      }
      let data = null;
      try {
        data = JSON.parse(xhr.responseText || 'null');
      } catch {
        /* Error body not JSON — errorFromBody names the status */
      }
      const err = errorFromBody(data, xhr.status);
      if (isSessionLost(err)) leaveForLogin();
      reject(err);
    });

    xhr.addEventListener('error', () => reject(new ApiError({ code: 'UPLOAD_FAILED', detail: 'Upload failed' })));
    xhr.addEventListener('abort', () => {
      if (stalled) reject(new ApiError({ code: 'UPLOAD_STALLED', detail: `Upload stalled: no progress for ${UPLOAD_IDLE_MS / 1000} s` }));
      else if (replyTimedOut) reject(new ApiError({ code: 'TIMEOUT', detail: 'The server did not answer after the upload' }));
      else reject(new ApiError({ code: 'UPLOAD_CANCELLED', detail: 'Upload cancelled' }));
    });

    armIdle();
    xhr.send(formData);
  });
}
