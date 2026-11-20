/**
 * Mutating container tools — admin scope only. Deliberately a SUBSET of the
 * REST API: agents get deploy/update/lifecycle and a filtered app-config
 * surface, never mounts, devices, runAsRoot, deletes, or secret-bearing
 * fields. Human-only concerns stay in the UI.
 *
 * Deploy, image update, the lifecycle and the image check are jobs, as on the
 * REST API: the tool checks what it can at once (those errors return
 * immediately), starts the job and returns its ack
 * `{ jobId, kind, title, subject }`; `get_job` reads it to the end.
 */
import { getContainerConfig } from '../../containerManager/index.js';
import { getAppModule, maskContainerConfigSecrets } from '../../containerApps/index.js';
import { validateContainerName } from '../../validation.js';
import { createAppError } from '../../appErrors.js';
import {
  startContainerDeployJob,
  startContainerImageUpdateJob,
  startContainerStartJob,
  startContainerStopJob,
  startContainerRestartJob,
  saveContainerAppConfig,
} from '../../containerOperations.js';
import { startImageUpdateCheckJob } from '../../updateChecks.js';

const JOB_NOTE = 'A job: returns { jobId, kind, title, subject } at once; read it with get_job until it is done.';

const RESTART_POLICIES = ['never', 'on-failure', 'unless-stopped', 'always'];

/* tools/call arguments arrive unvalidated (inputSchema is advisory to the
   client), so every handler re-validates what it uses. Each command is the
   container operation the REST routes call (lib/containerOperations.js), its
   lock and follow-ups included — a busy container answers CONTAINER_BUSY. */

function buildEnv(env, secretEnv) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value !== 'string') {
      throw createAppError('INVALID_REQUEST', `env.${key} must be a string`);
    }
    out[key] = { value };
  }
  for (const [key, value] of Object.entries(secretEnv ?? {})) {
    if (typeof value !== 'string') {
      throw createAppError('INVALID_REQUEST', `secretEnv.${key} must be a string`);
    }
    out[key] = { value, secret: true };
  }
  return out;
}

function buildSettingsChanges(args) {
  const changes = {};
  if (args.restartPolicy !== undefined) {
    if (!RESTART_POLICIES.includes(args.restartPolicy)) {
      throw createAppError('INVALID_REQUEST', `restartPolicy must be one of: ${RESTART_POLICIES.join(', ')}`);
    }
    changes.restartPolicy = args.restartPolicy;
  }
  if (args.autostart !== undefined) changes.autostart = args.autostart === true;
  if (args.autoBackup !== undefined) changes.autoBackup = args.autoBackup === true;
  if (args.localDns !== undefined) changes.localDns = args.localDns === true;
  if (args.cpuLimit !== undefined) {
    if (!(typeof args.cpuLimit === 'number' && args.cpuLimit > 0)) {
      throw createAppError('INVALID_REQUEST', 'cpuLimit must be a positive number of cores');
    }
    changes.cpuLimit = args.cpuLimit;
  }
  if (args.memoryLimitMiB !== undefined) {
    if (!(Number.isInteger(args.memoryLimitMiB) && args.memoryLimitMiB > 0)) {
      throw createAppError('INVALID_REQUEST', 'memoryLimitMiB must be a positive integer');
    }
    changes.memoryLimitMiB = args.memoryLimitMiB;
  }
  return changes;
}

export const containerAdminTools = [
  {
    name: 'deploy_container',
    title: 'Deploy a container',
    description:
      'Create a new container from an OCI image and start it. It joins the host bridge with its own ' +
      'DHCP LAN IP and registers <name>.local (localDns defaults true). Use a fully-qualified image ' +
      'ref (e.g. zotty.anapana.trixbits.ro/acdtrx/app:tag). Deliberately simple on purpose: no ' +
      'mounts, devices, root, or app templates — configure those in the Wisp UI. Put secret env ' +
      'values in secretEnv (stored write-only; get_container can never read them back). ' + JOB_NOTE +
      ' Its result is the new container (secrets masked).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name (becomes <name>.local)' },
        image: { type: 'string', description: 'Fully-qualified OCI image ref' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Plain env vars' },
        secretEnv: { type: 'object', additionalProperties: { type: 'string' }, description: 'Secret env vars (write-only)' },
        restartPolicy: {
          type: 'string',
          enum: RESTART_POLICIES,
          description: 'What Wisp does when the container exits on its own: never; on-failure (restart on a non-zero exit); ' +
            'unless-stopped / always (restart on any exit). Restarts back off from 1s to 5 min; a stop through Wisp is never undone. ' +
            'Default: unless-stopped',
        },
        autostart: { type: 'boolean', description: 'Start at host boot (default false)' },
        autoBackup: { type: 'boolean', description: 'Include in the daily scheduled backup (default false)' },
        localDns: { type: 'boolean', description: 'Register <name>.local via mDNS (default true)' },
        cpuLimit: { type: 'number', minimum: 0, description: 'CPU cores cap' },
        memoryLimitMiB: { type: 'integer', minimum: 1, description: 'Memory cap in MiB' },
      },
      required: ['name', 'image'],
      additionalProperties: false,
    },
    scope: 'admin',
    handler: async (args, { log } = {}) => {
      const { name, image } = args;
      validateContainerName(name);
      if (typeof image !== 'string' || !image.trim()) {
        throw createAppError('INVALID_REQUEST', 'image is required');
      }
      const env = buildEnv(args.env, args.secretEnv);
      const changes = buildSettingsChanges(args); // validate before creating anything

      return startContainerDeployJob({ name, image: image.trim(), env, changes, log });
    },
  },
  {
    name: 'update_container_image',
    title: 'Update a container image',
    description:
      'Point a container at a new image ref, or re-pull its current tag to pick up a newer digest ' +
      '(rootfs is rebuilt from the image on every start). Running containers are restarted to apply; ' +
      'stopped ones apply at next start. Use fully-qualified refs as shown by list_images; a short ' +
      'Docker Hub ref (nginx:1.27) is stored normalized (docker.io/library/nginx:1.27). ' + JOB_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
        image: { type: 'string', description: 'New image ref; omit to re-pull the current one' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    scope: 'admin',
    handler: async ({ name, image }, { log } = {}) => {
      validateContainerName(name);
      return startContainerImageUpdateJob({ name, image, log });
    },
  },
  {
    name: 'start_container',
    title: 'Start a container',
    description: 'Start a stopped container (rootfs is re-prepared from its image; data in mounts persists). ' + JOB_NOTE,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Container name' } },
      required: ['name'],
      additionalProperties: false,
    },
    scope: 'admin',
    handler: async ({ name }, { log } = {}) => {
      validateContainerName(name);
      return startContainerStartJob({ name, log });
    },
  },
  {
    name: 'stop_container',
    title: 'Stop a container',
    description:
      'Stop a running container. Careful with infrastructure containers (reverse proxy, registry, ' +
      'identity provider) — stopping them takes down every service behind them. ' + JOB_NOTE,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Container name' } },
      required: ['name'],
      additionalProperties: false,
    },
    scope: 'admin',
    handler: async ({ name }, { log } = {}) => {
      validateContainerName(name);
      return startContainerStopJob({ name, log });
    },
  },
  {
    name: 'restart_container',
    title: 'Restart a container',
    description: 'Restart a running container (applies pending image/env changes; rootfs rebuilt from image). ' + JOB_NOTE,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Container name' } },
      required: ['name'],
      additionalProperties: false,
    },
    scope: 'admin',
    handler: async ({ name }, { log } = {}) => {
      validateContainerName(name);
      return startContainerRestartJob({ name, log });
    },
  },
  {
    name: 'update_app_config',
    title: 'Update an app container’s configuration (filtered)',
    description:
      'Change an app container’s appConfig — restricted to the fields that app marks agent-writable; ' +
      'everything else (secrets, certificate identity, auth settings) is carried forward unchanged ' +
      'and attempts to set it are rejected. Currently: caddy-reverse-proxy exposes "hosts" (the full ' +
      'replacement array of { subdomain, target } rows — read the current one via get_container ' +
      'first, then send it back modified). Other apps are not agent-configurable. Changes validate, ' +
      'regenerate the derived config, and live-reload when the app supports it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'App container name' },
        appConfig: {
          type: 'object',
          description: 'Partial appConfig — only agent-writable fields for that app',
          additionalProperties: true,
        },
      },
      required: ['name', 'appConfig'],
      additionalProperties: false,
    },
    scope: 'admin',
    handler: async ({ name, appConfig }) => {
      validateContainerName(name);
      if (!appConfig || typeof appConfig !== 'object' || Array.isArray(appConfig)) {
        throw createAppError('INVALID_REQUEST', 'appConfig must be an object');
      }
      // The merge builds on the config as read under the lock, so a
      // concurrent save can't slip between the read and the write.
      let appType;
      const result = await saveContainerAppConfig(name, (cfg) => {
        appType = cfg?.metadata?.app;
        if (!appType) {
          throw createAppError('CONFIG_ERROR', `Container "${name}" is not an app container`);
        }
        const writable = getAppModule(appType)?.agentWritableAppConfigFields ?? [];
        if (!writable.length) {
          throw createAppError('APP_CONFIG_ONLY', `The "${appType}" app is not agent-configurable — use the Wisp UI`);
        }
        const blocked = Object.keys(appConfig).filter((k) => !writable.includes(k));
        if (blocked.length) {
          throw createAppError(
            'APP_CONFIG_ONLY',
            `Field(s) not agent-writable for "${appType}": ${blocked.join(', ')}. Writable: ${writable.join(', ')}. Everything else is configured in the Wisp UI.`,
          );
        }
        // Merged onto the RAW stored config (unmasked, server-side) so protected
        // fields — secrets included — pass through the standard validate path
        // completely untouched by the agent's input.
        return { ...cfg.metadata.appConfig, ...appConfig };
      });
      const after = await maskContainerConfigSecrets(await getContainerConfig(name));
      return {
        name,
        app: appType,
        appliedFields: Object.keys(appConfig),
        ...result,
        appConfig: after.metadata?.appConfig ?? null,
      };
    },
  },
  {
    name: 'check_image_updates',
    title: 'Check for image updates',
    description:
      'Run the image update digest check now (otherwise hourly); while a check runs, this returns that job. ' +
      'Its result counts the images checked and updated and the containers flagged; list_images then shows ' +
      'which containers have a newer image. Apply one with update_container_image. ' + JOB_NOTE,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'admin',
    handler: async (_args, { log } = {}) => startImageUpdateCheckJob({ log }),
  },
];
