import { createAppError } from '../appErrors.js';

/**
 * The fetches' `maxBodyBytes` option: `res` with its body bounded. A
 * Content-Length past the bound fails at once; otherwise the body fails with
 * DOWNLOAD_FAILED at the first chunk past it, however it is read (`text()`,
 * `json()`, a stream), and the rest of it is not read. Without a bound, `res`
 * as is.
 */
export async function limitBody(res, maxBodyBytes) {
  if (maxBodyBytes == null || !res.body) return res;
  const tooLarge = () => createAppError('DOWNLOAD_FAILED', `The answer is larger than ${maxBodyBytes} bytes`);
  const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (declared > maxBodyBytes) {
    await res.body.cancel().catch(() => {
      /* the body is abandoned either way */
    });
    throw tooLarge();
  }
  let loaded = 0;
  const limiter = new TransformStream({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      if (loaded > maxBodyBytes) {
        controller.error(tooLarge());
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(res.body.pipeThrough(limiter), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
