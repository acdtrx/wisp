import { getCloudInitConfig } from '../lib/cloudInit.js';
import { saveVmCloudInit, removeVmCloudInit } from '../lib/vmOperations.js';
import { cloudInitSchema, noContentSchema, vmParamsSchema } from './schemas.js';

export default async function cloudInitRoutes(fastify) {
  // GET /vms/:name/cloudinit — returns sanitized cloud-init config
  fastify.get('/vms/:name/cloudinit', {
    config: { auth: 'read' },
    schema: {
      params: vmParamsSchema(),
      response: { 200: cloudInitSchema },
    },
    handler: async (request) => {
      const config = await getCloudInitConfig(request.params.name);
      return config || { enabled: false };
    },
  });

  // PUT /vms/:name/cloudinit — save config, generate ISO, attach sde
  fastify.put('/vms/:name/cloudinit', {
    config: { auth: 'admin' },
    schema: {
      params: vmParamsSchema(),
      body: cloudInitSchema,
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await saveVmCloudInit(request.params.name, request.body);
      reply.code(204).send();
    },
  });

  // DELETE /vms/:name/cloudinit — detach sde, delete ISO + config
  fastify.delete('/vms/:name/cloudinit', {
    config: { auth: 'admin' },
    schema: {
      params: vmParamsSchema(),
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await removeVmCloudInit(request.params.name);
      reply.code(204).send();
    },
  });
}
