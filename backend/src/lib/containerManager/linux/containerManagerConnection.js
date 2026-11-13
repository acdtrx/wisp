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
  /** false (connect option): no containerd events stream — so no restart
   *  policy on task exits — inert network reconciler, uncached container
   *  list. For a short-lived process (the migration runner) that must not act
   *  alongside the backend. */
  watchEvents: true,
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
    try { h(); } catch (err) { containerState.logger?.warn?.({ err: err?.message || err }, '[containerManager] connect handler threw'); }
  }
}

function fireDisconnect() {
  for (const h of disconnectHandlers) {
    try { h(); } catch (err) { containerState.logger?.warn?.({ err: err?.message || err }, '[containerManager] disconnect handler threw'); }
  }
}

export function containerError(code, message, raw) {
  const err = new Error(message);
  err.code = code;
  if (raw) err.raw = raw;
  return err;
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

/*
 * CODING-RULES §6: every unary call carries a deadline — 30 s unless the call
 * names its own (`deadlineMs`; null for none, e.g. tasks.wait, which lasts as
 * long as the process it waits on); content read streams 60 s. The long-lived
 * events stream has no deadline; channel keepalive notices a containerd that
 * stopped answering instead. containerd's gRPC server refuses pings more often
 * than every 5 min (ENHANCE_YOUR_CALM) and without an active call, hence 6 min
 * and no pings while idle.
 */
export const DEFAULT_DEADLINE_MS = 30_000;
export const STREAM_DEADLINE_MS = 60_000;
const CHANNEL_OPTIONS = {
  'grpc.keepalive_time_ms': 6 * 60_000,
  'grpc.keepalive_timeout_ms': 20_000,
  'grpc.keepalive_permit_without_calls': 0,
};

function createClient(ServiceClass) {
  return new ServiceClass(
    `unix:${SOCKET_PATH}`,
    grpc.credentials.createInsecure(),
    CHANNEL_OPTIONS,
  );
}

function callOptions(deadlineMs) {
  return deadlineMs == null ? {} : { deadline: new Date(Date.now() + deadlineMs) };
}

function namespaceMeta() {
  const meta = new grpc.Metadata();
  meta.add('containerd-namespace', NAMESPACE);
  return meta;
}

/**
 * Promisify a unary gRPC call with the wisp namespace header and a deadline
 * (`deadlineMs`, default DEFAULT_DEADLINE_MS; null for none).
 */
export function callUnary(client, method, request = {}, { deadlineMs = DEFAULT_DEADLINE_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    const call = client[method](request, namespaceMeta(), callOptions(deadlineMs), (err, response) => {
      signal?.removeEventListener('abort', onAbort);
      if (err) {
        if (err.code === grpc.status.CANCELLED && signal?.aborted) {
          reject(signal.reason ?? containerError('CONTAINERD_ERROR', `${method} was cancelled`, err.message));
        } else if (err.code === grpc.status.DEADLINE_EXCEEDED) {
          reject(containerError('CONTAINERD_ERROR', `containerd did not answer ${method} within ${Math.round(deadlineMs / 1000)} s`, err.message));
        } else if (err.code === grpc.status.NOT_FOUND) {
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
    // `signal` cancels the call; it rejects with the signal's reason.
    function onAbort() { call.cancel(); }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Open a server-streaming gRPC call with the wisp namespace header and an
 * optional deadline for the whole stream (`deadlineMs`; none by default — the
 * events subscription lives as long as the connection).
 * Returns the stream object (EventEmitter with 'data', 'end', 'error').
 */
export function callStream(client, method, request = {}, { deadlineMs = null } = {}) {
  return client[method](request, namespaceMeta(), callOptions(deadlineMs));
}

/** Open a bidirectional gRPC stream with the wisp namespace header (no deadline). */
export function callBidi(client, method) {
  return client[method](namespaceMeta(), {});
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
 * Unpack a google.protobuf.Any field.
 *
 * containerd's typeurl uses proto.Marshal for proto.Message values (binary)
 * and json.Marshal for everything else (e.g. OCI runtime spec). We dispatch
 * on type_url: if a registered protobufjs Type matches, decode binary;
 * otherwise fall back to JSON parsing.
 */
export function unpackAny(any) {
  if (!any || !any.value) return null;
  const buf = any.value;
  if (!buf || buf.length === 0) return null;

  const typeUrl = any.typeUrl || any.type_url || '';
  const fullName = typeUrl.includes('/')
    ? typeUrl.slice(typeUrl.lastIndexOf('/') + 1)
    : typeUrl;
  const typeDef = fullName ? containerState.protoTypes?.[fullName] : null;
  if (typeDef?.type) {
    try {
      const decoded = typeDef.type.decode(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      return typeDef.type.toObject(decoded, { longs: String, defaults: false });
    } catch {
      /* binary decode failed — fall through to JSON */
    }
  }

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
      if (err.code === grpc.status.DEADLINE_EXCEEDED) {
        reject(containerError('CONTAINERD_ERROR', 'containerd did not finish the stream in time', err.message));
      } else if (err.code === grpc.status.UNAVAILABLE) {
        reject(containerError('NO_CONTAINERD', 'containerd is not reachable', err.message));
      } else {
        reject(containerError('CONTAINERD_ERROR', err.details || err.message, err.message));
      }
    });
  });
}

/**
 * @param {{ logger?: import('fastify').FastifyBaseLogger, watchEvents?: boolean }} [opts]
 *   watchEvents false: connection and calls only — see containerState.watchEvents.
 */
export async function connect(opts = {}) {
  if (opts.logger) containerState.logger = opts.logger;
  if (typeof opts.watchEvents === 'boolean') containerState.watchEvents = opts.watchEvents;

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
  const streamingPkg = loadProto('containerd/services/streaming/v1/streaming.proto');

  // Load Transfer types via protobufjs directly for binary encoding.
  // @grpc/proto-loader converts Types to descriptor objects (no encode/decode),
  // so we need raw protobufjs Types for packProtoAny.
  const transferRoot = new protobuf.Root();
  transferRoot.resolvePath = (_origin, target) => resolve(PROTOS_DIR, target);
  transferRoot.loadSync([
    'containerd/types/transfer/registry.proto',
    'containerd/types/transfer/imagestore.proto',
    'containerd/types/transfer/progress.proto',
    'containerd/services/streaming/v1/streaming.proto',
  ]);

  // Cgroup metrics types — used by unpackAny to decode tasks.Metrics payloads.
  const cgroupRoot = new protobuf.Root();
  cgroupRoot.resolvePath = (_origin, target) => resolve(PROTOS_DIR, target);
  cgroupRoot.loadSync([
    'containerd/cgroups/v1/metrics.proto',
    'containerd/cgroups/v2/metrics.proto',
  ]);

  // Task event payloads — the restart policy decodes /tasks/exit envelopes.
  const eventsRoot = new protobuf.Root();
  eventsRoot.resolvePath = (_origin, target) => resolve(PROTOS_DIR, target);
  eventsRoot.loadSync(['containerd/events/task.proto']);

  containerState.protoTypes = {
    'containerd.events.TaskExit': {
      type: eventsRoot.lookupType('containerd.events.TaskExit'),
    },
    'containerd.types.transfer.OCIRegistry': {
      type: transferRoot.lookupType('containerd.types.transfer.OCIRegistry'),
    },
    'containerd.types.transfer.ImageStore': {
      type: transferRoot.lookupType('containerd.types.transfer.ImageStore'),
    },
    'containerd.types.transfer.Progress': {
      type: transferRoot.lookupType('containerd.types.transfer.Progress'),
    },
    'containerd.services.streaming.v1.StreamInit': {
      type: transferRoot.lookupType('containerd.services.streaming.v1.StreamInit'),
    },
    'io.containerd.cgroups.v1.Metrics': {
      type: cgroupRoot.lookupType('io.containerd.cgroups.v1.Metrics'),
    },
    'io.containerd.cgroups.v2.Metrics': {
      type: cgroupRoot.lookupType('io.containerd.cgroups.v2.Metrics'),
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
    streaming: createClient(streamingPkg.containerd.services.streaming.v1.Streaming),
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
