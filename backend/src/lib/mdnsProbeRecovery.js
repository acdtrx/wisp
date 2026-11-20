/**
 * Triggers of avahi's stuck-probe recovery (app glue). avahi 0.8 strands an
 * entry group probing on an interface that goes away (republishProbingGroups
 * in the mdns module); the interfaces Wisp itself removes are a container's
 * veth, with its netns, and a stopped VM's tap. After each removal every Wisp
 * group still probing is re-published, whatever it publishes.
 */
import { subscribeContainerNetnsRemoved } from './containerManager/index.js';
import { subscribeVMStopped } from './vmManager/index.js';
import { republishProbingGroups } from './mdns/index.js';

let unsubscribes = [];

export function startMdnsProbeRecovery() {
  if (unsubscribes.length > 0) return; // already started
  unsubscribes = [
    subscribeContainerNetnsRemoved((name) => {
      republishProbingGroups({ event: 'container-netns-removed', container: name });
    }),
    subscribeVMStopped((name) => {
      republishProbingGroups({ event: 'vm-stopped', vm: name });
    }),
  ];
}

export function stopMdnsProbeRecovery() {
  for (const unsubscribe of unsubscribes) unsubscribe();
  unsubscribes = [];
}
