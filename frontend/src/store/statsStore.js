import { TOPIC } from '../../../shared/wireNames.js';
import { createStreamStore, topicSource } from './streamStore.js';

/** Host statistics, from the `stats` topic. An error frame keeps the last good stats:
 *  every consumer dereferences `data.cpu` / `data.memory`. */
export const useStatsStore = createStreamStore({ source: topicSource(TOPIC.STATS) });
