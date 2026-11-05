import { data } from '@takaro/helpers';
import { deliverPendingItems } from './wtr-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod } = data;
  if (!pog) return;
  const delivered = await deliverPendingItems(gameServerId, mod.moduleId, pog.playerId);
  if (delivered > 0) {
    await pog.pm(`Your Weekly Top prize is here: ${delivered} item reward${delivered === 1 ? '' : 's'} delivered.`);
  }
}

await main();
