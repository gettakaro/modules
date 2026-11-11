import { data, TakaroUserError, checkPermission } from '@takaro/helpers';
import { deleteVar, KEYS, readVar, writeVar } from './pm-helpers.js';

async function main() {
  const { pog, player, gameServerId, module: mod } = data;
  if (!mod.userConfig.socialSpy) {
    throw new TakaroUserError('Social spy is turned off on this server.');
  }
  if (!checkPermission(pog, 'PM_SPY')) {
    throw new TakaroUserError('You do not have permission to use social spy.');
  }

  const current = await readVar(gameServerId, mod.moduleId, player.id, KEYS.spy, null);
  if (current.id) {
    await deleteVar(current.id);
    await pog.pm('Social spy OFF. You no longer see copies of private messages.');
  } else {
    await writeVar(gameServerId, mod.moduleId, player.id, KEYS.spy, null, true);
    await pog.pm('Social spy ON. You now see copies of private messages and mail while online.');
  }
}

await main();
