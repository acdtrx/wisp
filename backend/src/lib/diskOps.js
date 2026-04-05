import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { createAppError } from './routeErrors.js';

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
 * Copy and convert image to qcow2. Progress reported via onProgress(percent).
 * Source file is never modified.
 */
export async function copyAndConvert(srcPath, dstPath, onProgress) {
  try {
    await access(srcPath, constants.R_OK);
  } catch {
    /* ENOENT or permission */
    throw createAppError('DISK_NOT_FOUND', `Disk image not found: ${srcPath}`);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('qemu-img', ['convert', '-O', 'qcow2', '-p', srcPath, dstPath], {
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
