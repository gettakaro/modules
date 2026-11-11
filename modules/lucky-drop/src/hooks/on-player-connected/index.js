import { data } from '@takaro/helpers';
import { KEYS, setVariable } from './lucky-drop-helpers.js';

async function main() {
  const { gameServerId, module: mod, player } = data;
  if (!player) return;
  await setVariable(gameServerId, mod.moduleId, KEYS.session, new Date().toISOString(), player.id);
}

await main();
