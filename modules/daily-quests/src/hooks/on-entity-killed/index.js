import { data } from '@takaro/helpers';
import { createContext, trackProgress, splitList } from './quest-helpers.js';

async function main() {
  const { player, eventData } = data;
  if (!player) return;
  const entity = String((eventData && eventData.entity) || '').toLowerCase();
  const ctx = createContext(data);
  // Filter is a comma-separated list of name fragments, e.g. "zombie,wolf". Empty = any kill.
  await trackProgress(ctx, player.id, 'kill', 1, (quest) => {
    const wanted = splitList(quest.filter);
    return wanted.length === 0 || wanted.some((w) => entity.includes(w));
  });
}

await main();
