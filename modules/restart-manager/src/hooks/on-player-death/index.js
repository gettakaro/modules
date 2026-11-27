import { data } from '@takaro/helpers';
import { setLastPvpAt } from './rm-helpers.js';

async function main() {
  const { gameServerId, eventData, module: mod } = data;
  if (!(Number(mod.userConfig.pvpQuietMinutes) > 0)) return;

  const attacker = eventData && eventData.attacker;
  const victim = eventData && eventData.player;
  // Only player-vs-player deaths count. Some games (7 Days to Die) never send the attacker.
  if (!attacker || !attacker.gameId || (victim && attacker.gameId === victim.gameId)) {
    console.log('restart-manager: death without another player as attacker, not PvP');
    return;
  }
  await setLastPvpAt(gameServerId, mod.moduleId, Date.now());
  console.log(`restart-manager: PvP kill by ${attacker.name || attacker.gameId}, restarts wait ${mod.userConfig.pvpQuietMinutes} min`);
}

await main();
