import { TOPIC } from '../../../shared/wireNames.js';
import { createStreamStore, topicSource } from './streamStore.js';

/** Each workload's last backup attempt, from the `backups` topic: `data` is
 *  `{ vms: { [name]: attempt }, containers: { [name]: attempt } }`. */
export const useBackupsStore = createStreamStore({
  source: topicSource(TOPIC.BACKUPS),
  toData: (frame) => (frame && typeof frame === 'object' && !Array.isArray(frame) ? frame : undefined),
});
