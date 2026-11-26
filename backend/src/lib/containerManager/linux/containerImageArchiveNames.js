/**
 * The names an image archive gives its images, read from the `saved` events
 * of its import (each image's descriptor, with the archive's annotations), and
 * the `localhost/` name each is stored under. The archive is untrusted: its
 * names are checked against the image reference grammar before any is used.
 */
import { containerError } from '../containerManagerShared.js';
import { isImageImportWorkName, isTaggedImageName, localImageNameFor } from './containerImageRef.js';

const ANNOTATION_IMAGE_NAME = 'io.containerd.image.name';
const ANNOTATION_REF_NAME = 'org.opencontainers.image.ref.name';
/** How much of an archive's name an error repeats. */
const NAME_IN_MESSAGE_MAX = 200;

/** The full name an image carries in the archive, or null: one with no repository names none. */
function archiveImageName(annotations) {
  const name = annotations?.[ANNOTATION_IMAGE_NAME];
  if (name) return name;
  const ref = annotations?.[ANNOTATION_REF_NAME];
  // A ref name of a tag alone (`v1`) names no repository.
  return typeof ref === 'string' && /[/:@]/.test(ref) ? ref : null;
}

/** An archive's name as an error quotes it: its own text, cut short. */
function quoted(name) {
  const text = String(name);
  return JSON.stringify(text.length > NAME_IN_MESSAGE_MAX ? `${text.slice(0, NAME_IN_MESSAGE_MAX)}…` : text);
}

/**
 * The archive's images with their `localhost/` names, in its order, one per
 * name. Refused, the archive whole: a name that is not an image reference of
 * a name and a tag, one under Wisp's own prefix, two names that give one
 * `localhost/` name to different images, or no name at all.
 */
export function namedImages(saved) {
  const byName = new Map();
  for (const ev of saved) {
    const archiveName = archiveImageName(ev.desc?.annotations);
    if (archiveName === null) continue;
    if (!isTaggedImageName(archiveName)) {
      throw containerError('CONTAINER_IMAGE_ARCHIVE_INVALID', `The archive names ${quoted(archiveName)}, which is not a valid image reference`);
    }
    const name = localImageNameFor(archiveName);
    if (!isTaggedImageName(name)) {
      throw containerError('CONTAINER_IMAGE_ARCHIVE_INVALID', `The archive's name ${quoted(archiveName)} gives ${quoted(name)}, which is not a valid image reference`);
    }
    if (isImageImportWorkName(name)) {
      throw containerError('CONTAINER_IMAGE_ARCHIVE_INVALID', `The archive names ${quoted(archiveName)}, a name Wisp keeps for its imports`);
    }
    const earlier = byName.get(name);
    if (earlier && earlier.desc.digest !== ev.desc.digest) {
      throw containerError(
        'CONTAINER_IMAGE_ARCHIVE_INVALID',
        `The archive's names ${quoted(earlier.archiveName)} and ${quoted(archiveName)} both give ${name}, to different images`,
      );
    }
    if (!earlier) byName.set(name, { archiveName, name, desc: ev.desc });
  }
  if (byName.size === 0) throw containerError('CONTAINER_IMAGE_ARCHIVE_UNNAMED', 'The archive names no image');
  return [...byName.values()];
}
