/**
 * Centralized error handling for route handlers. All failures return { error: string, detail: string }.
 */

/**
 * Create an app error with code, message, and optional raw detail (for route handlers that expect { code, message, raw }).
 */
export function createAppError(code, message, raw) {
  const err = new Error(message);
  err.code = code;
  if (raw) err.raw = raw;
  return err;
}

function errorCodeToStatus(code) {
  switch (code) {
    case 'BAD_MULTIPART_TOO_MANY_FILES':
      return 400;
    case 'VM_NOT_FOUND':
    case 'SNAPSHOT_NOT_FOUND':
    case 'BACKUP_NOT_FOUND':
      return 404;
    case 'VM_ALREADY_RUNNING':
    case 'VM_NOT_RUNNING':
    case 'VM_NOT_PAUSED':
    case 'VM_RUNNING':
    case 'VM_EXISTS':
    case 'VM_MUST_BE_OFFLINE':
      return 409;
    case 'PARSE_ERROR':
    case 'CLONE_FAILED':
    case 'RESIZE_INVALID':
    case 'DISK_NOT_FOUND':
    case 'RESIZE_FAILED':
    case 'CONVERT_FAILED':
    case 'USB_ATTACH_FAILED':
    case 'USB_DETACH_FAILED':
    case 'SNAPSHOT_CREATE_FAILED':
    case 'SNAPSHOT_REVERT_FAILED':
    case 'SNAPSHOT_DELETE_FAILED':
    case 'CONFIG_ERROR':
    case 'INVALID_VM_NAME':
    case 'INVALID_USB_ID':
    case 'BACKUP_INVALID':
    case 'HASH_FAILED':
    case 'INVALID_URL':
    case 'SSRF_BLOCKED':
    case 'DNS_FAILED':
    case 'DOWNLOAD_FAILED':
    case 'NO_BODY':
    case 'INVALID_REQUEST':
      return 422;
    case 'BACKUP_DEST_NOT_FOUND':
    case 'BACKUP_DEST_NOT_WRITABLE':
    case 'UPDATE_CHECK_UNAVAILABLE':
    case 'POWER_UNAVAILABLE':
      return 503;
    case 'BACKUP_RESTORE_FAILED':
      return 500;
    case 'DISK_INFO_FAILED':
    case 'LIBVIRT_ERROR':
      return 500;
    case 'NO_CONNECTION':
    case 'NO_CONTAINERD':
      return 503;
    case 'CONTAINER_NOT_FOUND':
    case 'CONTAINER_MOUNT_NOT_FOUND':
    case 'CONTAINER_IMAGE_NOT_FOUND':
      return 404;
    case 'CONTAINER_ALREADY_RUNNING':
    case 'CONTAINER_NOT_RUNNING':
    case 'CONTAINER_EXISTS':
    case 'CONTAINER_MUST_BE_STOPPED':
    case 'CONTAINER_IMAGE_IN_USE':
      return 409;
    case 'INVALID_APP_CONFIG':
    case 'APP_CONFIG_ONLY':
    case 'APP_RELOAD_FAILED':
    case 'UNKNOWN_APP_TYPE':
    case 'INVALID_CONTAINER_IMAGE_REF':
    case 'IMAGE_PULL_FAILED':
    case 'INVALID_CONTAINER_NAME':
    case 'INVALID_CONTAINER_MAC':
    case 'INVALID_CONTAINER_MOUNTS':
    case 'CONTAINER_MOUNT_DUPLICATE':
    case 'CONTAINER_MOUNT_TYPE_MISMATCH':
    case 'CONTAINER_ZIP_INVALID':
    case 'CONTAINER_ZIP_UNSAFE':
    case 'CONTAINER_MOUNT_SOURCE_MISSING':
    case 'CONTAINER_MOUNT_SOURCE_WRONG_TYPE':
    case 'CONTAINER_MOUNT_FILE_TOO_LARGE':
    case 'CONTAINER_MOUNT_FILE_NOT_UTF8':
    case 'INVALID_NETWORK_BRIDGE_NAME':
    case 'INVALID_NETWORK_BRIDGE_PARENT':
    case 'INVALID_VLAN_ID':
    case 'NETWORK_MOUNT_INVALID':
      return 422;
    case 'NETWORK_BRIDGE_EXISTS':
    case 'NETWORK_BRIDGE_IN_USE':
    case 'NETWORK_MOUNT_DUPLICATE':
      return 409;
    case 'NETWORK_BRIDGE_NOT_FOUND':
    case 'NETWORK_MOUNT_NOT_FOUND':
      return 404;
    case 'NETWORK_BRIDGE_UNAVAILABLE':
    case 'NETWORK_BRIDGE_APPLY_FAILED':
      return 503;
    case 'CONTAINERD_ERROR':
    case 'GITHUB_API':
    case 'NO_ASSET':
      return 500;
    default:
      return 500;
  }
}

/**
 * Handle errors from vmManager (or similar) that have { code, message, raw? }. Maps code to HTTP status and sends { error, detail }.
 */
export function handleRouteError(err, reply, request) {
  const status = errorCodeToStatus(err?.code);
  if (status >= 500 && request?.log) {
    request.log.error({ err: err.message, code: err.code, detail: err.raw || err.message }, 'Route error');
  }
  reply.code(status).send({
    error: err?.message ?? 'Internal error',
    detail: err?.raw ?? err?.message ?? 'Unknown error',
  });
}

/**
 * Send a consistent error response. Use for non-vmManager errors (e.g. host, settings).
 */
export function sendError(reply, status, error, detail) {
  reply.code(status).send({ error, detail: detail ?? error });
}
