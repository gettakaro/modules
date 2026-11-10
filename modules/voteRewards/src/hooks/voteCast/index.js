import { data } from '@takaro/helpers';
import { deliverPending, grantImmediate, hasInGameReward, savePending } from './rewards.js';

async function main() {
  const { player, pog, eventData } = data;
  // GH #4605: only a verified vote names its Player; an unverified one is never rewarded.
  if (eventData.verified !== true || !player || !pog) {
    return;
  }

  await grantImmediate(player.id);
  if (!hasInGameReward()) {
    return;
  }

  // Saved first, so a failed or throwing delivery leaves the reward waiting rather than lost.
  await savePending(eventData.voteId, eventData.castAt, player.id);
  if (pog.online) {
    await deliverPending(pog, player);
  }
}

await main();
