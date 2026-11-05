import { data } from '@takaro/helpers';
import { createContext, trackProgress, loadState, saveState, dayKey } from './quest-helpers.js';

async function main() {
  const { player, eventData } = data;
  if (!player) return;
  const amount = Math.floor(Number((eventData && eventData.amount) || 0));
  if (amount <= 0) return;
  const ctx = createContext(data);
  if ((ctx.config.enabledTypes || {}).currency === false) return;

  // Payouts made by this module are remembered in ignoreCredits; they must not count as "earned".
  const record = await loadState(ctx, player.id);
  const state = record.state;
  if (state && Array.isArray(state.ignoreCredits)) {
    const idx = state.ignoreCredits.indexOf(amount);
    if (idx !== -1) {
      state.ignoreCredits.splice(idx, 1);
      await saveState(ctx, player.id, record);
      console.log(`daily-quests: ignored own payout of ${amount}`);
      return;
    }
  }
  // Skip the second variable read when the player has no open currency quest today.
  if (state && state.day === dayKey(ctx.now, ctx.config.resetHourUtc)) {
    if (!state.quests.some((q) => q.type === 'currency' && !q.done)) return;
  }
  await trackProgress(ctx, player.id, 'currency', amount);
}

await main();
