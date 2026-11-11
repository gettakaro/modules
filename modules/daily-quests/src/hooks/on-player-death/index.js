import { data } from '@takaro/helpers';
import { createContext, trackProgress } from './quest-helpers.js';

async function main() {
  const { player } = data;
  if (!player) return;
  await trackProgress(createContext(data), player.id, 'death', 1);
}

await main();
