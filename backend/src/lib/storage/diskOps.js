import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { createAppError } from '../routeErrors.js';

const execFile = promisify(execFileCb);

export async function getDiskInfo(filePath) {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    /* ENOENT or permission */
    throw createAppError('DISK_NOT_FOUND', `Disk image not found: ${filePath}`);
  }

  try {
    const { stdout } = await execFile('qemu-img', ['info', '--output=json', filePath]);
    const info = JSON.parse(stdout);
    return {
      format: info.format,
      virtualSize: info['virtual-size'],
      actualSize: info['actual-size'],
      filename: info.filename,
    };
  } catch (err) {
    throw createAppError('DISK_INFO_FAILED', `Failed to read disk info for ${filePath}`, err.stderr || err.message);
  }
}

/**
 * The image's backing chain, top first: `[{ filename, format }]`. One entry
 * means a standalone image; more mean `filePath` is an overlay whose content
 * depends on every file below it (the last entry is the chain's base).
 * A missing backing file fails like any unreadable image (DISK_INFO_FAILED).
 * Pass the image's known `format` (a domain's `<driver type>`): a probed raw
 * image whose guest-written first bytes look like a qcow2 header would
 * otherwise report a backing file of the guest's choosing.
 */
export async function getBackingChain(filePath, { format } = {}) {
  const formatArgs = format ? ['-f', format] : [];
  let stdout;
  try {
    ({ stdout } = await execFile('qemu-img', ['info', ...formatArgs, '--backing-chain', '--output=json', filePath], {
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (err) {
    throw createAppError('DISK_INFO_FAILED', `Failed to read the backing chain of ${filePath}`, err.stderr || err.message);
  }
  let chain;
  try {
    chain = JSON.parse(stdout);
  } catch (err) {
    throw createAppError('DISK_INFO_FAILED', `qemu-img info returned unparsable JSON for ${filePath}`, err.message);
  }
  // --backing-chain always answers with an array, one ImageInfo per layer.
  if (!Array.isArray(chain) || chain.length === 0
    || !chain.every((img) => img && typeof img.filename === 'string' && img.filename)) {
    throw createAppError('DISK_INFO_FAILED', `qemu-img info returned an unexpected backing chain for ${filePath}`);
  }
  return chain.map((img) => ({ filename: img.filename, format: typeof img.format === 'string' ? img.format : null }));
}

/**
 * Copy and convert image to qcow2. Progress reported via onProgress(percent).
 * An overlay source is read through its whole backing chain, so the output is
 * a standalone image holding the merged content. `srcFormat`, when known,
 * skips format probing of the source (see getBackingChain).
 * Source file is never modified.
 */
export async function copyAndConvert(srcPath, dstPath, onProgress, { srcFormat } = {}) {
  try {
    await access(srcPath, constants.R_OK);
  } catch {
    /* ENOENT or permission */
    throw createAppError('DISK_NOT_FOUND', `Disk image not found: ${srcPath}`);
  }

  return new Promise((resolve, reject) => {
    const formatArgs = srcFormat ? ['-f', srcFormat] : [];
    const proc = spawn('qemu-img', ['convert', ...formatArgs, '-O', 'qcow2', '-p', srcPath, dstPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lastPercent = -1;
    const onLine = (line) => {
      const match = line.match(/\((\d+(?:\.\d+)?)\/100%?\)/);
      if (match) {
        const pct = Math.min(100, parseFloat(match[1], 10));
        if (pct !== lastPercent && typeof onProgress === 'function') {
          lastPercent = pct;
          onProgress(pct, line.trim());
        }
      }
    };

    const rlErr = createInterface({ input: proc.stderr, crlfDelay: Infinity });
    rlErr.on('line', onLine);
    const rlOut = proc.stdout
      ? createInterface({ input: proc.stdout, crlfDelay: Infinity })
      : null;
    if (rlOut) rlOut.on('line', onLine);

    proc.on('error', (err) => {
      rlErr.close();
      if (rlOut) rlOut.close();
      reject(createAppError('CONVERT_FAILED', `Failed to run qemu-img convert: ${err.message}`, err.message));
    });

    proc.on('close', (code, signal) => {
      rlErr.close();
      if (rlOut) rlOut.close();
      if (signal) {
        reject(createAppError('CONVERT_FAILED', `qemu-img convert killed by signal ${signal}`, String(signal)));
        return;
      }
      if (code !== 0) {
        reject(createAppError('CONVERT_FAILED', `qemu-img convert exited with code ${code}`, String(code)));
        return;
      }
      resolve({ ok: true, path: dstPath });
    });
  });
}

export async function resizeDisk(filePath, newSizeGB) {
  try {
    await access(filePath, constants.W_OK);
  } catch {
    /* missing or not writable */
    throw createAppError('DISK_NOT_FOUND', `Disk image not found or not writable: ${filePath}`);
  }

  const info = await getDiskInfo(filePath);
  const currentGB = info.virtualSize / (1024 ** 3);
  if (newSizeGB <= currentGB) {
    throw createAppError('RESIZE_INVALID', `New size (${newSizeGB}GB) must be larger than current size (${currentGB.toFixed(1)}GB)`);
  }

  try {
    await execFile('qemu-img', ['resize', filePath, `${newSizeGB}G`]);
  } catch (err) {
    throw createAppError('RESIZE_FAILED', `Failed to resize disk ${filePath}`, err.stderr || err.message);
  }

  return { ok: true, newSizeGB };
}
