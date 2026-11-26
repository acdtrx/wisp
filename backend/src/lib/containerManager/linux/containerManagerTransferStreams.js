/**
 * The streams of containerd's Transfer service, carried by its Streaming
 * service: a transfer names a stream by the id it was opened with. A pull's
 * progress comes back on one; an import's archive is sent on another.
 */
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

import {
  containerError, getClient, callBidi, packProtoAny, unpackAny,
} from './containerManagerConnection.js';

/** Opening a stream is one round trip. */
const STREAM_OPEN_MS = 30_000;
/** containerd's own chunk size for a binary stream: one Data message carries at most this. */
const DATA_CHUNK_BYTES = 32 * 1024;

/**
 * Open a stream for a transfer to name: resolves `{ id, stream, close }` once
 * containerd acknowledges it. `purpose` names it in an error.
 */
function openTransferStream(purpose) {
  const id = `wisp-${randomBytes(8).toString('hex')}`;
  const stream = callBidi(getClient('streaming'), 'stream');
  const close = () => { try { stream.cancel(); } catch { /* a stream that already ended refuses the cancel: it is ended either way */ } };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      close();
      reject(containerError('CONTAINERD_ERROR', `containerd did not open the ${purpose} stream within ${STREAM_OPEN_MS / 1000} s`));
    }, STREAM_OPEN_MS);
    stream.once('error', (err) => {
      clearTimeout(timer);
      reject(containerError('CONTAINERD_ERROR', `Could not open the ${purpose} stream`, err.message));
    });
    stream.once('data', () => { // the ack: the stream is ready
      clearTimeout(timer);
      stream.removeAllListeners('error');
      resolve({ id, stream, close });
    });
    stream.write(packProtoAny('containerd.services.streaming.v1.StreamInit', { id }));
  });
}

/**
 * Open a transfer progress stream: its id goes into the transfer's options,
 * and `onEvent` gets each progress event.
 */
export async function openProgressStream(onEvent) {
  const { id, stream, close } = await openTransferStream('transfer progress');
  stream.on('data', (any) => onEvent(unpackAny(any)));
  stream.on('error', () => { /* ends with the transfer: a lost stream only loses progress */ });
  return { id, close };
}

/**
 * Open a stream that sends the file `fh` to containerd, the sender's side of
 * its binary stream protocol: containerd grants a window of bytes at a time
 * (WindowUpdate), and the file goes in Data messages within it, then the
 * stream is half-closed at its end. `onProgress` runs on each window granted:
 * containerd took the bytes before it. `sent` settles with the byte count once
 * the file is sent, or once the stream ended or was closed first.
 */
export async function openFileSendStream(fh, onProgress) {
  const { id, stream, close } = await openTransferStream('image archive');
  let window = 0;
  let ended = false;
  let wake = null;
  const rouse = () => { const w = wake; wake = null; w?.(); };
  stream.on('data', (any) => {
    const update = unpackAny(any);
    if (!Number.isInteger(update?.update)) return;
    window += update.update;
    onProgress();
    rouse();
  });
  const stop = () => { ended = true; rouse(); };
  stream.on('error', stop);
  stream.on('end', stop);
  stream.on('close', stop);

  const sent = (async () => {
    let position = 0;
    try {
      for (;;) {
        while (window <= 0 && !ended) await new Promise((r) => { wake = r; });
        if (ended) return position;
        const length = Math.min(window, DATA_CHUNK_BYTES);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await fh.read(buffer, 0, length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        window -= bytesRead;
        const data = packProtoAny('containerd.types.transfer.Data', { data: buffer.subarray(0, bytesRead) });
        if (!stream.write(data)) await Promise.race([once(stream, 'drain'), once(stream, 'close')]);
      }
    } catch (err) {
      // The file could not be read, or the stream broke: containerd's side
      // ends with the cancel, and so does the transfer reading from it.
      stop();
      close();
      throw err;
    }
    stream.end();
    return position;
  })();

  return {
    id,
    sent,
    close: () => { stop(); close(); },
  };
}
