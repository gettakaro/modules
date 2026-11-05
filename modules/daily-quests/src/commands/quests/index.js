import { data } from '@takaro/helpers';
import {
  createContext,
  ensureToday,
  saveState,
  questLines,
  getSetting,
  msUntilReset,
  formatDuration,
  rerollsPerDayFor,
  pm,
} from './quest-helpers.js';

async function main() {
  const ctx = createContext(data);
  const playerId = data.player.id;
  const record = await ensureToday(ctx, playerId);
  if (record.fresh) await saveState(ctx, playerId, record);

  const state = record.state;
  const reset = formatDuration(msUntilReset(ctx.now, ctx.config.resetHourUtc));
  if (state.quests.length === 0) {
    await pm(ctx, playerId, `No daily quests are available on this server right now. Next reset in ${reset}.`);
    return;
  }

  const lines = await questLines(ctx, state);
  const doneCount = state.quests.filter((q) => q.done).length;
  const out = [`Daily quests (${doneCount}/${state.quests.length} done, reset in ${reset}):`, ...lines];

  const allowed = await rerollsPerDayFor(ctx, playerId);
  const left = allowed - (state.rerollsUsed || 0);
  if (left > 0 && doneCount < state.quests.length) {
    const prefix = await getSetting(ctx, 'commandPrefix', '/');
    const cost = ctx.config.rerollCost || 0;
    const costText = cost > 0 ? `${cost} ${await getSetting(ctx, 'currencyName', 'coins')}` : 'free';
    out.push(`Swap a quest: ${prefix}questreroll <number> (${costText}, ${left} left today)`);
  }
  // Some game chats (e.g. 7 Days to Die) don't render line breaks, so each line is its own message.
  for (const line of out) await pm(ctx, playerId, line);
}

await main();
