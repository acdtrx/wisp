import { api } from './client.js';
import { postMultipartFile } from './upload.js';

/** OCI images in containerd (wisp namespace). */
export function listContainerImages({ signal } = {}) {
  return api('/api/containers/images', { signal });
}

/** A job: answers `{ jobId, kind, title, subject }` (follow with awaitJob). */
export function deleteContainerImage(ref) {
  const params = new URLSearchParams({ ref });
  return api(`/api/containers/images?${params}`, { method: 'DELETE' });
}

/**
 * Start an image update check (bulk when no ref, single image when ref given).
 * A job: answers { jobId, kind, title, subject } (follow with awaitJob); a check started while one runs answers the running one.
 */
export function checkContainerImageUpdates(ref = null) {
  return api('/api/containers/images/check-updates', {
    method: 'POST',
    body: ref ? { ref } : {},
  });
}

export function getImageUpdateStatus({ signal } = {}) {
  return api('/api/containers/images/update-status', { signal });
}

export function createContainer(spec) {
  return api('/api/containers', { method: 'POST', body: spec });
}

export function getContainer(name, { signal } = {}) {
  return api(`/api/containers/${encodeURIComponent(name)}`, { signal });
}

export function updateContainer(name, changes) {
  return api(`/api/containers/${encodeURIComponent(name)}`, { method: 'PATCH', body: changes });
}

/** Turn an app container into a generic one (instant; the change arrives on the `changes` topic). */
export function ejectContainerApp(name) {
  return api(`/api/containers/${encodeURIComponent(name)}/eject`, { method: 'POST' });
}

/** On-demand host-side disk usage of each bind mount (can take seconds for large data dirs). */
export function getContainerMountUsage(name, { signal } = {}) {
  return api(`/api/containers/${encodeURIComponent(name)}/mounts/usage`, { signal });
}

/** Append one bind mount (row-scoped). */
export function addContainerMount(containerName, mountDef) {
  return api(`/api/containers/${encodeURIComponent(containerName)}/mounts`, {
    method: 'POST',
    body: mountDef,
  });
}

/** Update one mount by current storage key (`name` in config). Body: optional name, containerPath, readonly. */
export function updateContainerMount(containerName, mountName, changes) {
  return api(
    `/api/containers/${encodeURIComponent(containerName)}/mounts/${encodeURIComponent(mountName)}`,
    { method: 'PATCH', body: changes },
  );
}

/** Remove mount definition and delete files/<mountName> backing store. A job: answers `{ jobId, kind, title, subject }`. */
export function removeContainerMount(containerName, mountName) {
  return api(
    `/api/containers/${encodeURIComponent(containerName)}/mounts/${encodeURIComponent(mountName)}`,
    { method: 'DELETE' },
  );
}

/** Add an mDNS service advertisement on a port (row-scoped). */
export function addContainerService(containerName, serviceDef) {
  return api(`/api/containers/${encodeURIComponent(containerName)}/services`, {
    method: 'POST',
    body: serviceDef,
  });
}

/** Update an mDNS service identified by its port. Body: optional type, txt. */
export function updateContainerService(containerName, port, changes) {
  return api(
    `/api/containers/${encodeURIComponent(containerName)}/services/${port}`,
    { method: 'PATCH', body: changes },
  );
}

/** Remove an mDNS service by port. */
export function removeContainerService(containerName, port) {
  return api(
    `/api/containers/${encodeURIComponent(containerName)}/services/${port}`,
    { method: 'DELETE' },
  );
}

/** Delete, start, stop and restart are jobs: they answer `{ jobId, kind, title, subject }` (follow with awaitJob). */
export function deleteContainerApi(name, deleteFiles = true) {
  return api(`/api/containers/${encodeURIComponent(name)}?deleteFiles=${deleteFiles}`, { method: 'DELETE' });
}

export function startContainerApi(name) {
  return api(`/api/containers/${encodeURIComponent(name)}/start`, { method: 'POST' });
}

export function stopContainerApi(name) {
  return api(`/api/containers/${encodeURIComponent(name)}/stop`, { method: 'POST' });
}

export function restartContainerApi(name) {
  return api(`/api/containers/${encodeURIComponent(name)}/restart`, { method: 'POST' });
}

export function killContainerApi(name) {
  return api(`/api/containers/${encodeURIComponent(name)}/kill`, { method: 'POST' });
}

export function uploadMountFile(containerName, mountName, file, options) {
  const url = `/api/containers/${encodeURIComponent(containerName)}/mounts/${encodeURIComponent(mountName)}/file`;
  return postMultipartFile(url, file, options);
}

/** Answers once the upload is received: `{ jobId, kind, title, subject }` of the extract job. */
export function uploadMountZip(containerName, mountName, file, options) {
  const url = `/api/containers/${encodeURIComponent(containerName)}/mounts/${encodeURIComponent(mountName)}/zip`;
  return postMultipartFile(url, file, options);
}

export function getMountFileContent(containerName, mountName, { signal } = {}) {
  return api(
    `/api/containers/${encodeURIComponent(containerName)}/mounts/${encodeURIComponent(mountName)}/content`,
    { signal },
  );
}

export function putMountFileContent(containerName, mountName, content) {
  return api(
    `/api/containers/${encodeURIComponent(containerName)}/mounts/${encodeURIComponent(mountName)}/content`,
    { method: 'PUT', body: { content } },
  );
}

export function listContainerRuns(name, { signal } = {}) {
  return api(`/api/containers/${encodeURIComponent(name)}/runs`, { signal });
}

