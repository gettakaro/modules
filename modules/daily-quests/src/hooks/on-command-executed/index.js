import { data } from '@takaro/helpers';
import { createContext, trackProgress, splitList } from './quest-helpers.js';

async function main() {
  const { player, eventData } = data;
  if (!player || !eventData || !eventData.command) return;
  // Failed runs (no permission, cooldown, user error) don't count.
  if (eventData.result && eventData.result.success === false) return;
  const name = String(eventData.command.name || '').toLowerCase();
  if (!name) return;
  await trackProgress(createContext(data), player.id, 'command', 1, (quest) => splitList(quest.filter).includes(name));
}

await main();
