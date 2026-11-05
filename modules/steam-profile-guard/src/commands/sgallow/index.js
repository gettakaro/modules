import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';
import { KEYS, PERM, setVar } from './spg-core.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  if (!checkPermission(pog, PERM.manage)) {
    throw new TakaroUserError('You do not have permission to use sgallow.');
  }
  const target = args.player;
  if (!target || !target.playerId) throw new TakaroUserError('Usage: sgallow <player>');

  const prefix = (await takaro.settings.settingsControllerGetOne('commandPrefix', gameServerId)).data.data.value;
  const name = (await takaro.player.playerControllerGetOne(target.playerId)).data.data.name;
  await setVar(
    KEYS.allowed,
    { by: pog.playerId, at: new Date().toISOString() },
    gameServerId,
    target.playerId,
    mod.moduleId,
  );
  await pog.pm(
    `[Steam guard] ${name} is allowed: their Steam profile is no longer checked on join. Undo with ${prefix}sgunallow ${name}.`,
  );
}

await main();
