import { data, takaro } from '@takaro/helpers';
import { KEYS, checkPlayer, deleteVar, getStatus, handleResult, isExempt } from './npcheck-core.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const cfg = mod.userConfig;
  const moduleId = mod.moduleId;

  const pending = (
    await takaro.variable.variableControllerSearch({
      filters: { key: [KEYS.pending], gameServerId: [gameServerId], moduleId: [moduleId] },
      limit: 100,
    })
  ).data.data;

  // One player at a time: the module runner allows only a few requests in flight.
  for (const row of pending) {
    const playerId = row.playerId;
    let pog;
    try {
      pog = (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, playerId)).data.data;
    } catch (err) {
      console.log(`npcheck: player ${playerId} not found: ${err}`);
      await takaro.variable.variableControllerDelete(row.id);
      continue;
    }
    if (!pog.online) continue;
    const status = await getStatus(gameServerId, playerId, moduleId);
    if (isExempt(pog) || (status && status.value.status === 'reviewed')) {
      await takaro.variable.variableControllerDelete(row.id);
      continue;
    }

    const result = await checkPlayer(gameServerId, playerId, cfg);
    if (!result.inventory.known) {
      console.log(`npcheck: inventory of ${playerId} still not known`);
      continue;
    }
    await deleteVar(KEYS.pending, gameServerId, playerId, moduleId);
    const name = (await takaro.player.playerControllerGetOne(playerId)).data.data.name;
    await handleResult({ gameServerId, moduleId, cfg, playerId, name, result });
  }
}

await main();
