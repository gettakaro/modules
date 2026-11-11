import { data, takaro, TakaroUserError } from '@takaro/helpers';
import {
  createContext,
  ensureToday,
  saveState,
  eligibleQuests,
  pickQuests,
  snapshot,
  describeQuest,
  getSetting,
  rerollsPerDayFor,
  pm,
} from './quest-helpers.js';

async function main() {
  const ctx = createContext(data);
  const playerId = data.player.id;
  const prefix = await getSetting(ctx, 'commandPrefix', '/');
  const allowed = await rerollsPerDayFor(ctx, playerId);
  if (allowed <= 0) throw new TakaroUserError('Quest rerolls are disabled on this server.');

  const record = await ensureToday(ctx, playerId);
  const state = record.state;
  const index = Math.floor(Number(data.arguments.number)) - 1;
  if (!(index >= 0 && index < state.quests.length)) {
    if (record.fresh) await saveState(ctx, playerId, record);
    throw new TakaroUserError(
      `Pick a quest number from 1 to ${state.quests.length}. See ${prefix}quests, then ${prefix}questreroll <number>.`,
    );
  }
  const old = state.quests[index];
  if (old.done) throw new TakaroUserError('That quest is already done. Pick an open quest.');
  if ((state.rerollsUsed || 0) >= allowed) {
    throw new TakaroUserError(`You used all ${allowed} reroll(s) for today. Try again after the daily reset.`);
  }

  const pool = await eligibleQuests(ctx);
  const [next] = pickQuests(
    pool,
    1,
    state.quests.map((q) => q.id),
  );
  if (!next) throw new TakaroUserError('There are no other quests to swap to right now.');

  const cost = Math.max(0, Math.floor(Number(ctx.config.rerollCost || 0)));
  const currencyName = await getSetting(ctx, 'currencyName', 'coins');
  if (cost > 0) {
    const balance = Number(data.pog.currency || 0);
    if (balance < cost) {
      throw new TakaroUserError(`A reroll costs ${cost} ${currencyName}. You have ${balance}.`);
    }
    await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(ctx.gameServerId, playerId, {
      currency: cost,
    });
  }

  const fresh = snapshot(next);
  state.quests[index] = fresh;
  state.rerollsUsed = (state.rerollsUsed || 0) + 1;
  if (fresh.type === 'playtime') state.lastTick = ctx.now.toISOString();
  await saveState(ctx, playerId, record);

  const costText = cost > 0 ? ` for ${cost} ${currencyName}` : '';
  await pm(
    ctx,
    playerId,
    `Swapped "${await describeQuest(ctx, old)}" for "${await describeQuest(ctx, fresh)}"${costText}. Rerolls left today: ${allowed - state.rerollsUsed}.`,
  );
}

await main();
