import { data } from '@takaro/helpers';
import { KEYS, exemptReason, getJson, getProfile, handleResult, steamIdOf } from './spg-core.js';

async function main() {
  const { gameServerId, player, pog, module: mod } = data;
  const cfg = mod.userConfig;
  const moduleId = mod.moduleId;

  const steamId = await steamIdOf(player);
  if (!steamId) {
    console.log(`steam-guard: ${player.name} has no Steam ID; skipped`);
    return;
  }

  const reason = await exemptReason({
    pog,
    steamId,
    cfg,
    gameServerId,
    playerId: player.id,
    moduleId,
  });
  if (reason) {
    console.log(`steam-guard: ${player.name} ${reason}; skipped`);
    return;
  }

  if (cfg.checkMode === 'once') {
    const status = await getJson(KEYS.status, gameServerId, player.id, moduleId);
    if (status) {
      console.log(`steam-guard: ${player.name} was checked before (${status.status}); checkMode is once`);
      return;
    }
  }

  const { profile, cached, error } = await getProfile({
    gameServerId,
    moduleId,
    playerId: player.id,
    steamId,
    cfg,
    useCache: true,
  });
  if (!profile) {
    console.log(`steam-guard: no Steam data for ${player.name}: ${error}`);
    return;
  }
  if (cached) console.log('steam-guard: using cached Steam data');
  await handleResult({
    gameServerId,
    moduleId,
    cfg,
    playerId: player.id,
    name: player.name,
    steamId,
    profile,
  });
}

await main();
