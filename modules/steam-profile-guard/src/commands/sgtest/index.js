import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { PERM, isSteamId, testSteam } from './spg-core.js';

async function main() {
  const { pog, player, module: mod } = data;
  if (!checkPermission(pog, PERM.manage)) {
    throw new TakaroUserError('You do not have permission to use sgtest.');
  }
  const steamId = isSteamId(player.steamId) ? player.steamId : null;
  const result = await testSteam(mod.userConfig, steamId);
  for (const line of result.lines) console.log(`steam-guard: ${line}`);
  await pog.pm(`[Steam guard] ${result.lines.join(' ')}`);
}

await main();
