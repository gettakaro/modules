import { data, takaro } from '@takaro/helpers';
import { createContext, evaluatePlayer, describeStatus, sendPm } from './rank-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod } = data;
  const ctx = createContext(gameServerId);

  // Fresh record: the trigger snapshot may predate a role change or a playtime tick.
  const fresh = (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, pog.playerId)).data.data;
  const result = await evaluatePlayer({ ctx, moduleId: mod.moduleId, config: mod.userConfig, pog: fresh });

  await sendPm(gameServerId, pog.gameId, describeStatus(result));
}

await main();
