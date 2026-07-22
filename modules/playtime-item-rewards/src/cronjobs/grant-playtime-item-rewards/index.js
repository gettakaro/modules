import { data } from '@takaro/helpers';
import { processPlaytimeItemRewards } from './playtime-item-reward-helpers.js';

await processPlaytimeItemRewards(data.gameServerId, data.module);
