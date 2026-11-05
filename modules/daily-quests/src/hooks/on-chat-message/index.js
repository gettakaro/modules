import { data } from '@takaro/helpers';
import { createContext, trackProgress, getSetting, splitList } from './quest-helpers.js';

async function main() {
  const { player, eventData } = data;
  // Server messages and whispers sent by Takaro have no player.
  if (!player) return;
  const msg = String((eventData && eventData.msg) || '').trim();
  const ctx = createContext(data);
  const minLength = ctx.config.chatMinLength ?? 3;
  if (msg.length < minLength) return;

  await trackProgress(ctx, player.id, 'chat', 1, async (quest) => {
    // Commands show up as chat too; they never count as chatting.
    const prefix = await getSetting(ctx, 'commandPrefix', '/');
    if (msg.startsWith(prefix) || msg.startsWith('/')) return false;
    const wanted = splitList(quest.filter);
    return wanted.length === 0 || wanted.some((w) => msg.toLowerCase().includes(w));
  });
}

await main();
