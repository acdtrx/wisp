/*
 * The container list's cache and its announcements, with containerd faked: the
 * modules around the list are mocked (node --test
 * --experimental-test-module-mocks); the containers root is a temporary
 * directory.
 */
import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { containerError, wrapContainerError } from '../containerManagerShared.js';

const root = mkdtempSync(join(tmpdir(), 'wisp-list-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** The faked containerd: each task's status by name; `down` fails every lookup. */
const containerd = { tasks: new Map(), down: false, lookups: 0 };
const signals = {};

const url = (path) => new URL(path, import.meta.url).href;
mock.module(url('./containerManagerConnection.js'), {
  namedExports: {
    containerError,
    wrapContainerError,
    containerState: { connected: true, watchEvents: true, clients: {}, logger: null, containerStartTimes: new Map() },
    getClient: () => ({}),
    callStream: () => { throw new Error('no events stream in this test'); },
    subscribeContainerdConnect: () => () => {},
    subscribeContainerdDisconnect: (h) => { signals.disconnect = h; return () => {}; },
    subscribeContainerdConnectFailed: () => () => {},
    retryConnect: async () => {},
    NAMESPACE: 'wisp',
  },
});
mock.module(url('./containerPaths.js'), { namedExports: { getContainersPath: () => root } });
mock.module(url('./containerManagerLifecycle.js'), {
  namedExports: {
    getTaskState: async (name) => {
      containerd.lookups += 1;
      if (containerd.down) throw containerError('NO_CONTAINERD', 'containerd is not reachable');
      const status = containerd.tasks.get(name);
      return status ? { status, pid: 1 } : null;
    },
    containerTaskStatusToUi: (task) => task.status.toLowerCase(),
  },
});
mock.module(url('./procUptime.js'), { namedExports: { processUptimeMsFromProc: async () => null } });
mock.module(url('./containerManagerPendingRestart.js'), { namedExports: { pendingRestartInForce: async () => null } });
mock.module(url('../../mdns/index.js'), { namedExports: { getRegisteredHostname: () => null } });
mock.module(url('./containerManagerImageMeta.js'), { namedExports: { readLibraryDigestMap: async () => new Map() } });
mock.module(url('./containerManagerConfigIo.js'), {
  namedExports: {
    readContainerConfig: async (name) => {
      try {
        return JSON.parse(await (await import('node:fs/promises')).readFile(join(root, name, 'container.json'), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') throw containerError('CONTAINER_NOT_FOUND', `Container "${name}" not found`);
        throw err;
      }
    },
    subscribeContainerConfigWrite: (h) => { signals.configWrite = h; return () => {}; },
  },
});
mock.module(url('./containerManagerRestartPolicy.js'), {
  namedExports: {
    handleTaskExitEvent: () => {},
    getScheduledRestart: () => null,
    subscribeScheduledRestartChange: () => () => {},
  },
});

const { listContainers, refreshContainerListCache, subscribeContainerListChange } = await import('./containerManagerList.js');

/** Each announcement the subscribers got: a list's names and states, or null for an error. */
const frames = [];
subscribeContainerListChange((list) => { frames.push(list ? list.map((c) => `${c.name}:${c.state}`) : null); });

function create(name) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'container.json'), JSON.stringify({ name, image: 'busybox' }));
}

beforeEach(() => {
  signals.disconnect();
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root);
  containerd.tasks.clear();
  containerd.down = false;
  containerd.lookups = 0;
  frames.length = 0;
});

test('a refresh that gives the same list announces nothing; a changed one announces it', async () => {
  create('c');
  await listContainers();
  await refreshContainerListCache();
  await refreshContainerListCache();
  assert.deepEqual(frames, [['c:stopped']]);
  containerd.tasks.set('c', 'RUNNING');
  await refreshContainerListCache();
  assert.deepEqual(frames, [['c:stopped'], ['c:running']]);
});

test('list to error announces one error, the same error nothing, and error to list the list', async () => {
  create('c');
  await listContainers();
  containerd.down = true;
  await refreshContainerListCache();
  await assert.rejects(listContainers(), (err) => err.code === 'NO_CONTAINERD');
  await assert.rejects(listContainers(), (err) => err.code === 'NO_CONTAINERD');
  assert.deepEqual(frames, [['c:stopped'], null]);
  containerd.down = false;
  await listContainers();
  assert.deepEqual(frames, [['c:stopped'], null, ['c:stopped']]);
});

test('a directory without container.json is not a container; a malformed one fails the list', async () => {
  create('c');
  mkdirSync(join(root, 'kept', 'files'), { recursive: true });
  assert.deepEqual((await listContainers()).map((c) => c.name), ['c']);
  writeFileSync(join(root, 'c', 'container.json'), '{');
  await refreshContainerListCache();
  await assert.rejects(listContainers());
});
