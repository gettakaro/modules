import { data } from '@takaro/helpers';
import { createContext, trackProgress, splitList } from './quest-helpers.js';

async function main() {
  const { player, eventData } = data;
  if (!player) return;
  const names = [eventData && eventData.listingName, ...((eventData && eventData.items) || []).map((i) => i && i.name)]
    .filter(Boolean)
    .map((n) => String(n).toLowerCase());
  // Filter = comma-separated fragments of the listing or item name. Empty = any purchase.
  await trackProgress(createContext(data), player.id, 'shop', 1, (quest) => {
    const wanted = splitList(quest.filter);
    return wanted.length === 0 || wanted.some((w) => names.some((n) => n.includes(w)));
  });
}

await main();
