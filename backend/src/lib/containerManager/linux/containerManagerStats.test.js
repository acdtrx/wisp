/*
 * A container's figures by its state, with containerd faked: the modules around the
 * stats read are mocked (node --test --experimental-test-module-mocks).
 */
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

/** The faked containerd: the one task, its metrics, and the process's uptime from /proc. */
const containerd = { task: null, metrics: null, procUptime: null, metricsCalls: 0 };
const containerState = { containerStartTimes: new Map() };

const url = (path) => new URL(path, import.meta.url).href;
mock.module(url('./containerManagerConnection.js'), {
  exports: {
    containerState,
    getClient: () => ({}),
    callUnary: async () => {
      containerd.metricsCalls += 1;
      return { metrics: containerd.metrics ? [{ data: containerd.metrics }] : [] };
    },
    unpackAny: (data) => data,
  },
});
mock.module(url('./containerManagerLifecycle.js'), {
  exports: {
    getTaskState: async () => containerd.task,
    containerTaskStatusToUi: (task) => (task ? task.status.toLowerCase() : 'stopped'),
  },
});
mock.module(url('./procUptime.js'), { exports: { processUptimeMsFromProc: async () => containerd.procUptime } });

const { getContainerStats } = await import('./containerManagerStats.js');

beforeEach(() => {
  Object.assign(containerd, { task: null, metrics: null, procUptime: null, metricsCalls: 0 });
  containerState.containerStartTimes.clear();
});

test('a container without a task has no figures and no pid: null, never zero', async () => {
  assert.deepEqual(await getContainerStats('c'), {
    state: 'stopped', cpuPercent: null, memoryUsageMiB: null, uptime: null, pid: null,
  });
  assert.equal(containerd.metricsCalls, 0);
});

test('a paused container keeps its pid and has no figures', async () => {
  containerd.task = { status: 'PAUSED', pid: 4242 };
  containerd.metrics = { cpu: { usageUsec: 5_000_000 }, memory: { usage: 64 * 1024 * 1024 } };
  assert.deepEqual(await getContainerStats('c'), {
    state: 'paused', cpuPercent: null, memoryUsageMiB: null, uptime: null, pid: 4242,
  });
  assert.equal(containerd.metricsCalls, 0);
});

test('a running container has its figures', async () => {
  containerd.task = { status: 'RUNNING', pid: 4242 };
  containerd.metrics = { cpu: { usageUsec: 5_000_000 }, memory: { usage: 64 * 1024 * 1024 } };
  containerd.procUptime = 90_000;
  assert.deepEqual(await getContainerStats('c'), {
    state: 'running', cpuPercent: 0, memoryUsageMiB: 64, uptime: 90_000, pid: 4242,
  });
});

test('a running container whose start time is not known has no uptime', async () => {
  containerd.task = { status: 'RUNNING', pid: 4242 };
  assert.equal((await getContainerStats('c')).uptime, null);
  containerState.containerStartTimes.set('c', Date.now() - 5_000);
  const { uptime } = await getContainerStats('c');
  assert.ok(uptime >= 5_000 && uptime < 10_000, `uptime ${uptime}`);
});
