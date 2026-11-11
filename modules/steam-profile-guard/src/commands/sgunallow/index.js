import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';
import { KEYS, PERM, deleteVar, getVar } from './spg-core.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  if (!checkPermission(pog, PERM.manage)) {
    throw new TakaroUserError('You do not have permission to use sgunallow.');
  }
  const target = args.player;
  if (!target || !target.playerId) throw new TakaroUserError('Usage: sgunallow <player>');

  const name = (await takaro.player.playerControllerGetOne(target.playerId)).data.data.name;
  const existing = await getVar(KEYS.allowed, gameServerId, target.playerId, mod.moduleId);
  if (!existing) {
    await pog.pm(`[Steam guard] ${name} was not on the allow list.`);
    return;
  }
  await deleteVar(KEYS.allowed, gameServerId, target.playerId, mod.moduleId);
  await pog.pm(`[Steam guard] ${name} is checked again on their next join.`);
}

await main();
