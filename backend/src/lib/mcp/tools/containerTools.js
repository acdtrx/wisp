import {
  getContainerConfig,
  resolveRunId,
  getContainerRunLogs,
  listContainerImages,
  listContainers,
  getImageUpdateStatus,
} from '../../containerManager/index.js';
import { maskContainerConfigSecrets } from '../../containerApps/index.js';
import { validateContainerName } from '../../validation.js';

const LOG_LINES_DEFAULT = 100;
const LOG_LINES_MAX = 1000;

export const containerTools = [
  {
    name: 'get_container',
    title: 'Container detail',
    description:
      'Full configuration and state of one container: image, network (bridge, MAC, LAN IP), mounts, ' +
      'env (secret values masked), limits, restart policy, autostart, and — for app containers — ' +
      'metadata.app plus the masked appConfig. The appConfig is how you read any app\'s configuration: ' +
      'e.g. a caddy-reverse-proxy container\'s appConfig.hosts[] lists every exposed {subdomain, target}.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    scope: 'read',
    handler: async ({ name }) => {
      validateContainerName(name);
      return maskContainerConfigSecrets(await getContainerConfig(name));
    },
  },
  {
    name: 'get_container_logs',
    title: 'Container logs',
    description:
      'Tail of a container run log. Defaults to the newest run (the ongoing one if the container is ' +
      'running); pass runId to read an older run.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
        lines: {
          type: 'integer',
          minimum: 1,
          maximum: LOG_LINES_MAX,
          description: `How many trailing lines to return (default ${LOG_LINES_DEFAULT})`,
        },
        runId: { type: 'string', description: 'Specific run id (default: newest run)' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    scope: 'read',
    handler: async ({ name, lines, runId: requestedRunId }) => {
      validateContainerName(name);
      const count = Math.min(Math.max(Number.isInteger(lines) ? lines : LOG_LINES_DEFAULT, 1), LOG_LINES_MAX);
      const runId = await resolveRunId(name, typeof requestedRunId === 'string' ? requestedRunId : null);
      if (!runId) return { runId: null, lines: [] };
      const { lines: logLines } = await getContainerRunLogs(name, runId, count);
      return { runId, lines: logLines };
    },
  },
  {
    name: 'list_images',
    title: 'OCI images',
    description:
      'OCI images in the wisp containerd namespace (name, digest, size) plus which containers have a ' +
      'newer image digest available and when the hourly update check last ran.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'read',
    handler: async () => {
      const [images, containers] = await Promise.all([listContainerImages(), listContainers()]);
      return {
        images,
        updatesAvailable: containers
          .filter((c) => c.updateAvailable === true)
          .map((c) => ({ container: c.name, image: c.image })),
        lastCheck: getImageUpdateStatus(),
      };
    },
  },
];
