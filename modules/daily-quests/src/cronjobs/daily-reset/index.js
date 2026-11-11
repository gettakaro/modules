import { data, takaro } from '@takaro/helpers';
import { createContext, ensureToday, saveState, questLines, getSetting } from './quest-helpers.js';

async function main() {
  const ctx = createContext(data);
  const resetHour = ctx.config.resetHourUtc || 0;
  // Runs hourly; only the configured reset hour does anything. Quests also roll over lazily
  // on a player's first event of the day, so a missed run never blocks a reset.
  if (ctx.now.getUTCHours() !== resetHour) {
    console.log(`daily-reset: hour ${ctx.now.getUTCHours()} is not reset hour ${resetHour}, skipping`);
    return;
  }

  const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: { gameServerId: [ctx.gameServerId], online: [true] },
    limit: 100,
  });
  const prefix = await getSetting(ctx, 'commandPrefix', '/');
  let assigned = 0;

  for (const pog of res.data.data) {
    ctx._pogs[pog.playerId] = pog;
    try {
      const record = await ensureToday(ctx, pog.playerId);
      if (!record.fresh) continue;
      await saveState(ctx, pog.playerId, record);
      assigned++;
      if (ctx.config.announceNewQuests === false) continue;
      const lines = await questLines(ctx, record.state);
      // Some game chats (e.g. 7 Days to Die) don't render line breaks, so each line is its own message.
      const messages = ['New daily quests!', ...(lines.length ? lines : ['No quests available today.']), `Type ${prefix}quests for progress.`];
      for (const message of messages) {
        await takaro.gameserver.gameServerControllerSendMessage(ctx.gameServerId, {
          message,
          opts: { recipient: { gameId: pog.gameId } },
        });
      }
    } catch (err) {
      console.error(`daily-reset: failed for player ${pog.playerId}: ${err}`);
    }
  }
  console.log(`daily-reset: assigned new quests to ${assigned} online player(s)`);
}

await main();
