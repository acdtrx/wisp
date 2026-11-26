/**
 * An image archive upload (app glue): the upload is received into a staging
 * file, then imported into containerd as a job, which removes the file however
 * it ends (docs/specs/CONTAINERS.md → Image Management, Uploaded images).
 */
import { unlink } from 'node:fs/promises';

import { newImageImportStagingPath, storeImagesFromArchive } from './containerManager/index.js';
import { startJob, titleForContainerImageImport } from './jobs/index.js';
import { JOB_KIND } from '../../../shared/wireNames.js';

const FALLBACK_FILE_NAME = 'image archive';

/** The file name a client sent, without a path: the job's title names it. */
function displayFileName(fileName) {
  const base = typeof fileName === 'string' ? fileName.split(/[/\\]/).pop().trim() : '';
  return base || FALLBACK_FILE_NAME;
}

/**
 * Receive an image archive and import it as a job. `stage(path)` writes the
 * upload to `path` and resolves with the file name the client sent; a failure
 * there (no file, too large, a stalled body) answers before any job exists.
 * `done`: `{ images: [{ name, digest }] }`.
 */
export async function startContainerImageImportJob({ stage, log }) {
  const stagingPath = await newImageImportStagingPath();
  const removeStaging = () => unlink(stagingPath).catch(() => { /* never created, or already gone */ });
  let fileName;
  try {
    fileName = displayFileName(await stage(stagingPath));
  } catch (err) {
    await removeStaging();
    throw err;
  }
  try {
    return await startJob({
      kind: JOB_KIND.CONTAINER_IMAGE_IMPORT,
      title: titleForContainerImageImport(fileName),
      // A job that must finish (docs/specs/API.md → Jobs that may be cut): a
      // shutdown does not cut it, and a self-update is refused while it runs.
      log,
      run: async (report) => {
        report({ step: 'importing', detail: `Importing ${fileName}…` });
        return storeImagesFromArchive(stagingPath);
      },
    });
  } catch (err) {
    // No job (shutting down): nothing will import the file.
    await removeStaging();
    throw err;
  }
}
