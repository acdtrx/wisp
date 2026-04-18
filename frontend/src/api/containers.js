import { api } from './client.js';
import { postMultipartFile } from './upload.js';

export function listContainers() {
  return api('/api/containers');
}

/** OCI images in containerd (wisp namespace). */
export function listContainerImages() {
  return api('/api/containers/images');
}

export function deleteContainerImage(ref) {
  const params = new URLSearchParams({ ref });
  return api(`/api/containers/images?${params}`, { method: 'DELETE' });
}

/**
 * Start an image update check (bulk when no ref, single image when ref given).
 * Returns { jobId, title } — subscribe via JOB_KIND.CONTAINER_IMAGE_UPDATE_CHECK.
 */
export function checkContainerImageUpdates(ref = null) {
  return api('/api/containers/images/check-updates', {
    method: 'POST',
    body: ref ? { ref } : {},
  });
}

export function getImageUpdateStatus() {
  return api('/api/containers/images/update-status');
}

export function createContainer(spec) {
  return api('/api/containers', { method: 'POST', body: spec });
}

export function getContainer(name) {
  return api(`/api/containers/${encodeURIComponent(name)}`);
}

export function updateContainer(name, changes) {
  return api(`/api/containers/${encodeURIComponent(name)}`, { method: 'PATCH', body: changes });
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

/** Remove mount definition and delete files/<mountName> backing store. */
export function removeContainerMount(containerName, mountName) {
  return api(
    `/api/containers/${encodeURIComponent(containerName)}/mounts/${encodeURIComponent(mountName)}`,
    { method: 'DELETE' },
  );
}

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

export function uploadMountZip(containerName, mountName, file, options) {
  const url = `/api/containers/${encodeURIComponent(containerName)}/mounts/${encodeURIComponent(mountName)}/zip`;
  return postMultipartFile(url, file, options);
}

export function getMountFileContent(containerName, mountName) {
  return api(
    `/api/containers/${encodeURIComponent(containerName)}/mounts/${encodeURIComponent(mountName)}/content`,
  );
}

export function putMountFileContent(containerName, mountName, content) {
  return api(
    `/api/containers/${encodeURIComponent(containerName)}/mounts/${encodeURIComponent(mountName)}/content`,
    { method: 'PUT', body: { content } },
  );
}

export function listContainerRuns(name) {
  return api(`/api/containers/${encodeURIComponent(name)}/runs`);
}

export function deleteMountDataApi(containerName, mountName) {
  return api(
    `/api/containers/${encodeURIComponent(containerName)}/mounts/${encodeURIComponent(mountName)}/data`,
    { method: 'DELETE' },
  );
}
