import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';
import { KEYS, PERMS, getVariable, deleteVariable, awardDrop } from './lucky-drop-helpers.js';

async function main() {
  const { gameServerId, module: mod, player, pog } = data;
  const moduleId = mod.moduleId;
  const config = mod.userConfig;
  const nowMs = Date.now();

  const race = await getVariable(gameServerId, moduleId, KEYS.race);
  if (!race) {
    throw new TakaroUserError('There is no lucky drop to grab right now.');
  }
  if (new Date(race.expiresAt).getTime() <= nowMs) {
    throw new TakaroUserError('Too late, this lucky drop has expired.');
  }
  if (!checkPermission(pog, PERMS.eligible)) {
    throw new TakaroUserError('You are not allowed to grab lucky drops.');
  }

  // Claim lock: variable keys are unique, so only the first create succeeds.
  try {
    await takaro.variable.variableControllerCreate({
      key: `${KEYS.claimPrefix}${race.id}`,
      value: JSON.stringify(player.id),
      gameServerId,
      moduleId,
      expiresAt: new Date(nowMs + 24 * 3600 * 1000).toISOString(),
    });
  } catch (err) {
    throw new TakaroUserError('Someone was faster! The lucky drop is already taken.');
  }

  await deleteVariable(gameServerId, moduleId, KEYS.race);
  await awardDrop({
    gameServerId,
    moduleId,
    config,
    tier: race.tier,
    winner: { playerId: player.id, gameId: pog.gameId, name: player.name },
    mode: 'claimRace',
    nowMs,
  });
}

await main();
