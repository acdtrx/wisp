/**
 * containerd gRPC connection and low-level client access.
 * Single place for connection state and proto loading.
 * Only containerManager* modules import this; routes must not import grpc-js.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import protobuf from 'protobufjs';

import { createAppError } from '../../routeErrors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTOS_DIR = resolve(__dirname, '../../../protos');
const SOCKET_PATH = process.env.WISP_CONTAINERD_SOCK || '/run/containerd/containerd.sock';
const NAMESPACE = 'wisp';

export const IS_DARWIN = false;

export const containerState = {
  clients: null,
  connected: false,
  containerStartTimes: new Map(),
  /** @type {import('fastify').FastifyBaseLogger | null} */
  logger: null,
};

const connectHandlers = new Set();
const disconnectHandlers = new Set();

/** Subscribe to containerd-ready events; handler fires after each successful connect. */
export function subscribeContainerdConnect(handler) {
  connectHandlers.add(handler);
  return () => connectHandlers.delete(handler);
}

/** Subscribe to containerd-disconnect events; handler fires when the client is torn down. */
export function subscribeContainerdDisconnect(handler) {
  disconnectHandlers.add(handler);
  return () => disconnectHandlers.delete(handler);
}

function fireConnect() {
  for (const h of connectHandlers) {
    try { h(); } catch (err) { console.warn('[containerManager] connect handler threw:', err?.message || err); }
  }
}

function fireDisconnect() {
  for (const h of disconnectHandlers) {
    try { h(); } catch (err) { console.warn('[containerManager] disconnect handler threw:', err?.message || err); }
  }
}

export function containerError(code, message, raw) {
  return createAppError(code, message, raw);
}

const PROTO_OPTS = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_DIR],
};

function loadProtoDef(relPath) {
  return protoLoader.loadSync(
    Array.isArray(relPath) ? relPath.map((p) => resolve(PROTOS_DIR, p)) : resolve(PROTOS_DIR, relPath),
    PROTO_OPTS,
  );
}

function loadProto(relPath) {
  return grpc.loadPackageDefinition(loadProtoDef(relPath));
}

function createClient(ServiceClass) {
  return new ServiceClass(
    `unix:${SOCKET_PATH}`,
    grpc.credentials.createInsecure(),
  );
}

function namespaceMeta() {
  const meta = new grpc.Metadata();
  meta.add('containerd-namespace', NAMESPACE);
  return meta;
}

/**
 * Promisify a unary gRPC call with the wisp namespace header.
 */
export function callUnary(client, method, request = {}) {
  return new Promise((resolve, reject) => {
    client[method](request, namespaceMeta(), (err, response) => {
      if (err) {
        if (err.code === grpc.status.NOT_FOUND) {
          reject(containerError('CONTAINER_NOT_FOUND', err.details || err.message, err.message));
        } else if (err.code === grpc.status.ALREADY_EXISTS) {
          reject(containerError('CONTAINER_EXISTS', err.details || err.message, err.message));
        } else if (err.code === grpc.status.UNAVAILABLE) {
          reject(containerError('NO_CONTAINERD', 'containerd is not reachable', err.message));
        } else {
          reject(containerError('CONTAINERD_ERROR', err.details || err.message, err.message));
        }
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Open a server-streaming gRPC call with the wisp namespace header.
 * Returns the stream object (EventEmitter with 'data', 'end', 'error').
 */
export function callStream(client, method, request = {}) {
  return client[method](request, namespaceMeta());
}

/**
 * Pack a JS object into a google.protobuf.Any field.
 * Uses JSON encoding — correct for non-proto types (OCI runtime spec).
 * containerd's typeurl uses json.Marshal for non-proto types.
 */
export function packAny(typeUrl, obj) {
  return {
    typeUrl,
    type_url: typeUrl,
    value: Buffer.from(JSON.stringify(obj)),
  };
}

/**
 * Pack a JS object into a google.protobuf.Any field using protobuf binary encoding.
 * Required for containerd types that ARE protobuf messages (e.g. Transfer source/dest).
 * containerd's typeurl uses proto.Marshal for proto.Message types.
 *
 * @param {string} protoFullName - Fully qualified proto message name used as proto-loader key
 * @param {object} obj - JS object matching the message structure
 */
export function packProtoAny(protoFullName, obj) {
  const typeDef = containerState.protoTypes?.[protoFullName];
  if (!typeDef?.type) {
    throw containerError('CONTAINERD_ERROR', `Proto type "${protoFullName}" not loaded`);
  }
  const msgType = typeDef.type;
  const msg = msgType.create(obj);
  const encoded = msgType.encode(msg).finish();

  // containerd's typeurl v2: TypeURL() for proto messages returns the proto full name.
  // getTypeByUrl() falls through to protoregistry.GlobalTypes.FindMessageByURL()
  // which strips everything after the last '/' and looks up by full name.
  const fullName = msgType.fullName.startsWith('.')
    ? msgType.fullName.slice(1)
    : msgType.fullName;

  return {
    typeUrl: fullName,
    type_url: fullName,
    value: Buffer.from(encoded),
  };
}

/**
 * Unpack a google.protobuf.Any field as JSON.
 */
export function unpackAny(any) {
  if (!any || !any.value) return null;
  const buf = any.value;
  if (!buf || buf.length === 0) return null;
  try {
    return JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : buf);
  } catch {
    /* value is not JSON — expected for some Any payloads */
    return null;
  }
}

/**
 * Read all messages from a server stream into an array.
 */
export function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const items = [];
    stream.on('data', (msg) => items.push(msg));
    stream.on('end', () => resolve(items));
    stream.on('error', (err) => {
      if (err.code === grpc.status.UNAVAILABLE) {
        reject(containerError('NO_CONTAINERD', 'containerd is not reachable', err.message));
      } else {
        reject(containerError('CONTAINERD_ERROR', err.details || err.message, err.message));
      }
    });
  });
}

/**
 * @param {{ logger?: import('fastify').FastifyBaseLogger }} [opts]
 */
export async function connect(opts = {}) {
  if (opts.logger) containerState.logger = opts.logger;

  if (containerState.connected) return;

  const versionPkg = loadProto('containerd/services/version/v1/version.proto');
  const containersPkg = loadProto('containerd/services/containers/v1/containers.proto');
  const tasksPkg = loadProto('containerd/services/tasks/v1/tasks.proto');
  const imagesPkg = loadProto('containerd/services/images/v1/images.proto');
  const contentPkg = loadProto('containerd/services/content/v1/content.proto');
  const snapshotsPkg = loadProto('containerd/services/snapshots/v1/snapshots.proto');
  const eventsPkg = loadProto('containerd/services/events/v1/events.proto');
  const leasesPkg = loadProto('containerd/services/leases/v1/leases.proto');
  const transferPkg = loadProto('containerd/services/transfer/v1/transfer.proto');
  const namespacesPkg = loadProto('containerd/services/namespaces/v1/namespaces.proto');

  // Load Transfer types via protobufjs directly for binary encoding.
  // @grpc/proto-loader converts Types to descriptor objects (no encode/decode),
  // so we need raw protobufjs Types for packProtoAny.
  const transferRoot = new protobuf.Root();
  transferRoot.resolvePath = (_origin, target) => resolve(PROTOS_DIR, target);
  transferRoot.loadSync([
    'containerd/types/transfer/registry.proto',
    'containerd/types/transfer/imagestore.proto',
  ]);
  containerState.protoTypes = {
    'containerd.types.transfer.OCIRegistry': {
      type: transferRoot.lookupType('containerd.types.transfer.OCIRegistry'),
    },
    'containerd.types.transfer.ImageStore': {
      type: transferRoot.lookupType('containerd.types.transfer.ImageStore'),
    },
  };

  containerState.clients = {
    version: createClient(versionPkg.containerd.services.version.v1.Version),
    containers: createClient(containersPkg.containerd.services.containers.v1.Containers),
    tasks: createClient(tasksPkg.containerd.services.tasks.v1.Tasks),
    images: createClient(imagesPkg.containerd.services.images.v1.Images),
    content: createClient(contentPkg.containerd.services.content.v1.Content),
    snapshots: createClient(snapshotsPkg.containerd.services.snapshots.v1.Snapshots),
    events: createClient(eventsPkg.containerd.services.events.v1.Events),
    leases: createClient(leasesPkg.containerd.services.leases.v1.Leases),
    transfer: createClient(transferPkg.containerd.services.transfer.v1.Transfer),
    namespaces: createClient(namespacesPkg.containerd.services.namespaces.v1.Namespaces),
  };

  // Version check doubles as connectivity test
  const ver = await callUnary(containerState.clients.version, 'version');
  containerState.logger?.info(
    { containerdVersion: ver.version, revision: ver.revision },
    'Connected to containerd',
  );

  // Ensure the wisp namespace exists
  try {
    await callUnary(containerState.clients.namespaces, 'get', { name: NAMESPACE });
  } catch (err) {
    if (err.code !== 'CONTAINER_NOT_FOUND') throw err;
    await callUnary(containerState.clients.namespaces, 'create', {
      namespace: { name: NAMESPACE, labels: {} },
    });
    containerState.logger?.info({ namespace: NAMESPACE }, 'Created containerd namespace');
  }

  containerState.connected = true;
  fireConnect();
}

export function disconnect() {
  if (!containerState.clients) return;
  for (const client of Object.values(containerState.clients)) {
    if (client && typeof client.close === 'function') client.close();
  }
  containerState.clients = null;
  containerState.connected = false;
  containerState.containerStartTimes.clear();
  containerState.logger = null;
  fireDisconnect();
}

export function getClient(name) {
  if (!containerState.clients?.[name]) {
    throw containerError('NO_CONTAINERD', 'Not connected to containerd');
  }
  return containerState.clients[name];
}
