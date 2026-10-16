import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants, open } from 'node:fs/promises';
import { extname } from 'node:path';
import { createInterface } from 'node:readline';

import { createAppError } from '../routeErrors.js';

const execFile = promisify(execFileCb);

/*
 * Every qemu-img call names the image format (`-f`); none lets qemu-img probe
 * it. A probed format is chosen by the file's content: a raw guest disk whose
 * guest wrote a qcow2 header would be read as an overlay of a host file of the
 * guest's choosing, and a vmdk descriptor names arbitrary host files as its
 * extents. The format comes from the domain's `<driver type>` for a VM's own
 * disk, and from `imageFormatForFile` for a library or user-supplied image.
 */

/** The image formats a library or user-supplied image may have: neither can refer to another file except through the backing / data-file fields `inspectDiskImage` refuses. */
const SAFE_IMAGE_FORMATS = ['qcow2', 'raw'];

/** First four bytes of every qcow2 image ("QFI\xfb"). */
const QCOW2_MAGIC = Buffer.from([0x51, 0x46, 0x49, 0xfb]);

async function hasQcow2Magic(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buf = Buffer.alloc(QCOW2_MAGIC.length);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return bytesRead === buf.length && buf.equals(QCOW2_MAGIC);
  } catch (err) {
    throw createAppError('DISK_NOT_FOUND', `Disk image not readable: ${filePath}`, err.message);
  } finally {
    if (handle) await handle.close().catch(() => { /* read-only handle; nothing to flush */ });
  }
}

/**
 * The format of a library or user-supplied image file, from its extension:
 * `.qcow2` → qcow2 (the file must start with the qcow2 header magic), `.raw`
 * → raw, and `.img` — used for both (Ubuntu cloud images are qcow2 `.img`
 * files) — by that magic: qcow2 when the file starts with it, raw otherwise.
 * Only qcow2 is ever decided by content, and a qcow2 is then checked like any
 * other (`inspectDiskImage`). Any other extension (`.vmdk`, `.iso`, …) is
 * refused: convert the image to qcow2 on the host first.
 *
 * @returns {Promise<'qcow2' | 'raw'>}
 * @throws DISK_FORMAT_UNSUPPORTED (422)
 */
export async function imageFormatForFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.qcow2') {
    if (await hasQcow2Magic(filePath)) return 'qcow2';
    throw createAppError('DISK_FORMAT_UNSUPPORTED', `Not a qcow2 image: ${filePath}`, 'The file is named .qcow2 but has no qcow2 header');
  }
  if (ext === '.raw') return 'raw';
  if (ext === '.img') return (await hasQcow2Magic(filePath)) ? 'qcow2' : 'raw';
  throw createAppError(
    'DISK_FORMAT_UNSUPPORTED',
    `Unsupported disk image type: ${filePath}`,
    'Use a .qcow2, .raw or .img image — convert other formats (e.g. vmdk) to qcow2 on the host with qemu-img convert',
  );
}

/** `qemu-img info -f <format> --output=json`, parsed. */
async function readImageInfo(filePath, format) {
  if (typeof format !== 'string' || !format) {
    throw createAppError('DISK_INFO_FAILED', `No image format given for ${filePath}`);
  }
  try {
    await access(filePath, constants.R_OK);
  } catch {
    /* ENOENT or permission */
    throw createAppError('DISK_NOT_FOUND', `Disk image not found: ${filePath}`);
  }
  let stdout;
  try {
    ({ stdout } = await execFile('qemu-img', ['info', '-f', format, '--output=json', filePath]));
  } catch (err) {
    throw createAppError('DISK_INFO_FAILED', `Failed to read disk info for ${filePath} as ${format}`, err.stderr || err.message);
  }
  let info;
  try {
    info = JSON.parse(stdout);
  } catch (err) {
    throw createAppError('DISK_INFO_FAILED', `qemu-img info returned unparsable JSON for ${filePath}`, err.message);
  }
  if (!info || typeof info !== 'object' || typeof info['virtual-size'] !== 'number') {
    throw createAppError('DISK_INFO_FAILED', `qemu-img info returned an unexpected answer for ${filePath}`);
  }
  return info;
}

function summarizeImageInfo(info) {
  return {
    format: info.format,
    virtualSize: info['virtual-size'],
    actualSize: info['actual-size'],
    filename: info.filename,
  };
}

/**
 * Size and format of an image read as `format` (a domain disk's
 * `<driver type>`, or what `imageFormatForFile` decided).
 */
export async function getDiskInfo(filePath, { format } = {}) {
  return summarizeImageInfo(await readImageInfo(filePath, format));
}

/**
 * Check an image before Wisp converts, attaches or resizes it, read as
 * `format`: refuse a format other than qcow2/raw and anything through which
 * QEMU would open another file — a backing file (any qcow2 overlay, whatever
 * it names) or a qcow2 external data file. Returns what `getDiskInfo` does.
 *
 * @throws DISK_FORMAT_UNSUPPORTED (422) - format other than qcow2/raw
 * @throws DISK_IMAGE_UNSAFE (422) - backing file or external data file
 */
export async function inspectDiskImage(filePath, { format } = {}) {
  if (!SAFE_IMAGE_FORMATS.includes(format)) {
    throw createAppError(
      'DISK_FORMAT_UNSUPPORTED',
      `Unsupported disk image format "${format}": ${filePath}`,
      'Only qcow2 and raw images can be used — convert other formats to qcow2 on the host with qemu-img convert',
    );
  }
  const info = await readImageInfo(filePath, format);
  const backing = info['full-backing-filename'] ?? info['backing-filename'];
  if (backing != null) {
    throw createAppError(
      'DISK_IMAGE_UNSAFE',
      `Disk image ${filePath} has a backing file (${backing})`,
      'Only standalone images can be used — flatten it on the host with qemu-img convert -O qcow2',
    );
  }
  const dataFile = info['format-specific']?.data?.['data-file'];
  if (dataFile != null) {
    throw createAppError(
      'DISK_IMAGE_UNSAFE',
      `Disk image ${filePath} has an external data file (${dataFile})`,
      'Only self-contained images can be used — convert it on the host with qemu-img convert -O qcow2',
    );
  }
  return summarizeImageInfo(info);
}

/**
 * The image's backing chain, top first: `[{ filename, format }]`. One entry
 * means a standalone image; more mean `filePath` is an overlay whose content
 * depends on every file below it (the last entry is the chain's base).
 * A missing backing file fails like any unreadable image (DISK_INFO_FAILED).
 * `format` (required) is the image's known format — a domain's `<driver type>`.
 */
export async function getBackingChain(filePath, { format } = {}) {
  if (typeof format !== 'string' || !format) {
    throw createAppError('DISK_INFO_FAILED', `No image format given for ${filePath}`);
  }
  let stdout;
  try {
    ({ stdout } = await execFile('qemu-img', ['info', '-f', format, '--backing-chain', '--output=json', filePath], {
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
 * a standalone image holding the merged content — callers converting an
 * image they did not create check it with `inspectDiskImage` first.
 * `srcFormat` (required) is passed as `-f`. Source file is never modified.
 */
export async function copyAndConvert(srcPath, dstPath, onProgress, { srcFormat } = {}) {
  if (typeof srcFormat !== 'string' || !srcFormat) {
    throw createAppError('CONVERT_FAILED', `No source image format given for ${srcPath}`);
  }
  try {
    await access(srcPath, constants.R_OK);
  } catch {
    /* ENOENT or permission */
    throw createAppError('DISK_NOT_FOUND', `Disk image not found: ${srcPath}`);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('qemu-img', ['convert', '-f', srcFormat, '-O', 'qcow2', '-p', srcPath, dstPath], {
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

/**
 * Grow an image to `newSizeGB`. It is read as `format` (the domain disk's
 * `<driver type>`) and checked with `inspectDiskImage` first — `qemu-img
 * resize` opens the image's backing chain.
 */
export async function resizeDisk(filePath, newSizeGB, { format } = {}) {
  try {
    await access(filePath, constants.W_OK);
  } catch {
    /* missing or not writable */
    throw createAppError('DISK_NOT_FOUND', `Disk image not found or not writable: ${filePath}`);
  }

  const info = await inspectDiskImage(filePath, { format });
  const currentGB = info.virtualSize / (1024 ** 3);
  if (newSizeGB <= currentGB) {
    throw createAppError('RESIZE_INVALID', `New size (${newSizeGB}GB) must be larger than current size (${currentGB.toFixed(1)}GB)`);
  }

  try {
    await execFile('qemu-img', ['resize', '-f', format, filePath, `${newSizeGB}G`]);
  } catch (err) {
    throw createAppError('RESIZE_FAILED', `Failed to resize disk ${filePath}`, err.stderr || err.message);
  }

  return { ok: true, newSizeGB };
}
