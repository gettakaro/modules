import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { KEYS, PERMS, getVariable, runDrop, scheduleNext } from './lucky-drop-helpers.js';

async function main() {
  const { gameServerId, module: mod, pog, player } = data;
  const moduleId = mod.moduleId;
  const config = mod.userConfig;
  const nowMs = Date.now();

  if (!checkPermission(pog, PERMS.admin)) {
    throw new TakaroUserError('You do not have permission to force a lucky drop.');
  }

  const race = await getVariable(gameServerId, moduleId, KEYS.race);
  if (race && new Date(race.expiresAt).getTime() > nowMs) {
    throw new TakaroUserError('A claim race is still running. Wait until it ends.');
  }

  // Forced drops skip the timer, min online players, session time and AFK checks; the permission still counts.
  const status = await runDrop({ gameServerId, moduleId, config, nowMs });
  const at = await scheduleNext(gameServerId, moduleId, config, nowMs);
  console.log(`luckyDrop: forced by ${player.name}: ${status}`);
  await data.player.pm(`Lucky drop: ${status}. Next drop in about ${Math.round((at - nowMs) / 60000)} min.`);
}

await main();
