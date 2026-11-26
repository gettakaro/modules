import { data } from '@takaro/helpers';
import { bumpSignal } from './stx-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  await bumpSignal(gameServerId, mod.moduleId, 'deaths');
}

await main();
