import { TOPIC } from '../../../shared/wireNames.js';
import { createStreamStore, topicSource } from './streamStore.js';

/** The Wisp peers on the LAN, from the `discovery` topic. */
export const useDiscoveryStore = createStreamStore({
  source: topicSource(TOPIC.DISCOVERY),
  toData: (frame) => (Array.isArray(frame) ? frame : []),
  empty: [],
});
