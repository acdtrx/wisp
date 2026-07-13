/**
 * Mutating container tools — admin scope only. Deliberately a SUBSET of the
 * REST API: agents get deploy/update/lifecycle and a filtered app-config
 * surface, never mounts, devices, runAsRoot, deletes, or secret-bearing
 * fields. Human-only concerns stay in the UI.
 */
import {
  createContainer,
  getContainerConfig,
  updateContainerConfig,
  startContainer,
  stopContainer,
  restartContainer,
  pullImage,
  getImageDigest,
  listContainers,
  checkAllImagesForUpdates,
  getImageUpdateStatus,
} from '../../containerManager/index.js';
import {
  getAppModule,
  applyAppConfig,
  maskContainerConfigSecrets,
} from '../../containerApps/index.js';
import { validateContainerName } from '../../validation.js';
import { createAppError } from '../../routeErrors.js';

const RESTART_POLICIES = ['never', 'on-failure', 'unless-stopped', 'always'];

/* tools/call arguments arrive unvalidated (inputSchema is advisory to the
   client), so every handler re-validates what it uses. */

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
      'values in secretEnv (stored write-only; get_container can never read them back).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name (becomes <name>.local)' },
        image: { type: 'string', description: 'Fully-qualified OCI image ref' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Plain env vars' },
        secretEnv: { type: 'object', additionalProperties: { type: 'string' }, description: 'Secret env vars (write-only)' },
        restartPolicy: { type: 'string', enum: RESTART_POLICIES, description: 'Default: unless-stopped' },
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
    handler: async (args) => {
      const { name, image } = args;
      validateContainerName(name);
      if (typeof image !== 'string' || !image.trim()) {
        throw createAppError('INVALID_REQUEST', 'image is required');
      }
      const env = buildEnv(args.env, args.secretEnv);
      const changes = buildSettingsChanges(args); // validate before creating anything

      await createContainer({ name, image: image.trim(), env });
      if (Object.keys(changes).length) {
        await updateContainerConfig(name, changes);
      }
      try {
        await startContainer(name);
      } catch (err) {
        throw createAppError(
          err.code || 'CONTAINERD_ERROR',
          `Container "${name}" was created but failed to start: ${err.message}. It exists in stopped state — check get_container_logs, or fix and start_container.`,
          err.raw ?? err.message,
        );
      }
      return maskContainerConfigSecrets(await getContainerConfig(name));
    },
  },
  {
    name: 'update_container_image',
    title: 'Update a container image',
    description:
      'Point a container at a new image ref, or re-pull its current tag to pick up a newer digest ' +
      '(rootfs is rebuilt from the image on every start). Running containers are restarted to apply; ' +
      'stopped ones apply at next start. Use fully-qualified refs as shown by list_images.',
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
    handler: async ({ name, image }) => {
      validateContainerName(name);
      const cfg = await getContainerConfig(name);
      const ref = typeof image === 'string' && image.trim() ? image.trim() : cfg.image;
      try {
        await pullImage(ref);
      } catch (err) {
        // Locally-imported images have no registry to pull from — fine if present.
        if (!(await getImageDigest(ref))) {
          throw createAppError('IMAGE_PULL_FAILED', `Cannot pull "${ref}" and it is not present locally`, err.message);
        }
      }
      if (ref !== cfg.image) {
        await updateContainerConfig(name, { image: ref });
      }
      let restarted = false;
      if (cfg.state === 'running') {
        await restartContainer(name);
        restarted = true;
      }
      return {
        name,
        image: ref,
        restarted,
        applied: restarted,
        note: restarted ? 'Restarted on the updated image.' : 'Image updated; takes effect at the next start.',
      };
    },
  },
  {
    name: 'start_container',
    title: 'Start a container',
    description: 'Start a stopped container (rootfs is re-prepared from its image; data in mounts persists).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Container name' } },
      required: ['name'],
      additionalProperties: false,
    },
    scope: 'admin',
    handler: async ({ name }) => {
      validateContainerName(name);
      await startContainer(name);
      return { name, state: (await getContainerConfig(name)).state };
    },
  },
  {
    name: 'stop_container',
    title: 'Stop a container',
    description:
      'Stop a running container. Careful with infrastructure containers (reverse proxy, registry, ' +
      'identity provider) — stopping them takes down every service behind them.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Container name' } },
      required: ['name'],
      additionalProperties: false,
    },
    scope: 'admin',
    handler: async ({ name }) => {
      validateContainerName(name);
      await stopContainer(name);
      return { name, state: (await getContainerConfig(name)).state };
    },
  },
  {
    name: 'restart_container',
    title: 'Restart a container',
    description: 'Restart a running container (applies pending image/env changes; rootfs rebuilt from image).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Container name' } },
      required: ['name'],
      additionalProperties: false,
    },
    scope: 'admin',
    handler: async ({ name }) => {
      validateContainerName(name);
      await restartContainer(name);
      return { name, state: (await getContainerConfig(name)).state };
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
      const cfg = await getContainerConfig(name);
      const appType = cfg?.metadata?.app;
      if (!appType) {
        throw createAppError('CONFIG_ERROR', `Container "${name}" is not an app container`);
      }
      const appModule = getAppModule(appType);
      const writable = appModule?.agentWritableAppConfigFields ?? [];
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
      // Merge onto the RAW stored config (unmasked, server-side) so protected
      // fields — secrets included — pass through the standard validate path
      // completely untouched by the agent's input.
      const merged = { ...cfg.metadata.appConfig, ...appConfig };
      const result = await applyAppConfig(name, merged);
      const after = maskContainerConfigSecrets(await getContainerConfig(name));
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
      'Run the image-update digest check now (otherwise hourly) and report which containers have a ' +
      'newer image available. Apply one with update_container_image.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'admin',
    handler: async () => {
      await checkAllImagesForUpdates();
      const containers = await listContainers();
      return {
        lastCheck: getImageUpdateStatus(),
        updatesAvailable: containers
          .filter((c) => c.updateAvailable === true)
          .map((c) => ({ container: c.name, image: c.image })),
      };
    },
  },
];
