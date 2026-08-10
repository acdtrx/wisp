import { buildDeploymentOverview } from '../../deploymentOverview.js';

export const overviewTools = [
  {
    name: 'get_deployment_overview',
    title: 'Deployment overview',
    description:
      'One-call map of everything on this Wisp host: wisp version, host identity, network bridges, ' +
      'sidebar sections, every container (state, image, LAN IP while running — stopped containers ' +
      'report lastKnownIp, a possibly-reassigned DHCP lease — mDNS name, app template, autostart) ' +
      'and every VM (state, resources, LAN IP when the guest agent reports one). Start here to ' +
      'understand the deployment; drill into a workload with get_container / get_vm.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'read',
    /* The join itself lives in lib/deploymentOverview.js — the Home page's tile
     * derivation reads the same gather, so neither view can drift from the other. */
    handler: async () => buildDeploymentOverview(),
  },
];
