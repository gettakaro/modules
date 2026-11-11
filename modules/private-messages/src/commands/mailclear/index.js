import { data } from '@takaro/helpers';
import { deleteVar, KEYS, readVar } from './pm-helpers.js';

async function main() {
  const { pog, player, gameServerId, module: mod } = data;
  const box = await readVar(gameServerId, mod.moduleId, player.id, KEYS.mailbox, []);
  const count = Array.isArray(box.value) ? box.value.length : 0;
  await deleteVar(box.id);
  await pog.pm(count ? `Deleted ${count} mail${count === 1 ? '' : 's'}.` : 'Your mailbox was already empty.');
}

await main();
