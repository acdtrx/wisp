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
import { maskContainerConfigSecrets } from '../../containerApps/index.js';
import { containerNameSchema } from '../../validation.js';
import { openOnPurpose } from '../../schemaValidation.js';
import {
  startContainerDeployJob,
  startContainerImageUpdateJob,
  startContainerStartJob,
  startContainerStopJob,
  startContainerRestartJob,
  saveAgentAppConfig,
} from '../../containerOperations.js';
import { startImageUpdateCheckJob } from '../../updateChecks.js';

const JOB_NOTE = 'A job: returns { jobId, kind, title, subject } at once; read it with get_job until it is done.';

const RESTART_POLICIES = ['never', 'on-failure', 'unless-stopped', 'always'];

/* The arguments have passed the tool's inputSchema (lib/mcp/mcpServer.js).
   Each command is the container operation the REST routes call
   (lib/containerOperations.js), its lock and follow-ups included — a busy
   container answers CONTAINER_BUSY. */

const nameArgument = (description) => ({ ...containerNameSchema, description });

function buildEnv(env, secretEnv) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) out[key] = { value };
  for (const [key, value] of Object.entries(secretEnv ?? {})) out[key] = { value, secret: true };
  return out;
}

const SETTINGS_ARGUMENTS = ['restartPolicy', 'autostart', 'autoBackup', 'localDns', 'cpuLimit', 'memoryLimitMiB'];

/** The deploy's settings, applied as a configuration update after the create. */
function buildSettingsChanges(args) {
  return Object.fromEntries(SETTINGS_ARGUMENTS.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
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
        name: nameArgument('Container name (becomes <name>.local)'),
        image: { type: 'string', pattern: '\\S', description: 'Fully-qualified OCI image ref' },
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
        cpuLimit: { type: 'number', exclusiveMinimum: 0, description: 'CPU cores cap' },
        memoryLimitMiB: { type: 'integer', minimum: 1, description: 'Memory cap in MiB' },
      },
      required: ['name', 'image'],
      additionalProperties: false,
    },
    scope: 'admin',
    handler: async (args, { log } = {}) => {
      const { name, image } = args;
      return startContainerDeployJob({
        name, image: image.trim(), env: buildEnv(args.env, args.secretEnv), changes: buildSettingsChanges(args), log,
      });
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
        name: nameArgument('Container name'),
        image: { type: 'string', description: 'New image ref; omit to re-pull the current one' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    scope: 'admin',
    handler: async ({ name, image }, { log } = {}) => {
      return startContainerImageUpdateJob({ name, image, log });
    },
  },
  {
    name: 'start_container',
    title: 'Start a container',
    description: 'Start a stopped container (rootfs is re-prepared from its image; data in mounts persists). ' + JOB_NOTE,
    inputSchema: {
      type: 'object',
      properties: { name: nameArgument('Container name') },
      required: ['name'],
      additionalProperties: false,
    },
    scope: 'admin',
    handler: async ({ name }, { log } = {}) => {
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
      properties: { name: nameArgument('Container name') },
      required: ['name'],
      additionalProperties: false,
    },
    scope: 'admin',
    handler: async ({ name }, { log } = {}) => {
      return startContainerStopJob({ name, log });
    },
  },
  {
    name: 'restart_container',
    title: 'Restart a container',
    description: 'Restart a running container (applies pending image/env changes; rootfs rebuilt from image). ' + JOB_NOTE,
    inputSchema: {
      type: 'object',
      properties: { name: nameArgument('Container name') },
      required: ['name'],
      additionalProperties: false,
    },
    scope: 'admin',
    handler: async ({ name }, { log } = {}) => {
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
        name: nameArgument('App container name'),
        appConfig: openOnPurpose({
          type: 'object',
          description: 'Partial appConfig — only agent-writable fields for that app',
        }),
      },
      required: ['name', 'appConfig'],
      additionalProperties: false,
    },
    scope: 'admin',
    handler: async ({ name, appConfig }) => {
      const result = await saveAgentAppConfig(name, appConfig);
      const after = await maskContainerConfigSecrets(await getContainerConfig(name));
      return {
        name,
        app: after.metadata?.app ?? null,
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
