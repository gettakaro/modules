import { data, takaro } from '@takaro/helpers';
import { createContext, ensureToday, trackProgress, MAX_TICK_GAP_MS } from './quest-helpers.js';

async function onlinePogs(gameServerId) {
  const all = [];
  let page = 0;
  while (true) {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], online: [true] },
      page,
      limit: 100,
    });
    all.push(...res.data.data);
    if (res.data.data.length < 100) break;
    page++;
  }
  return all;
}

async function main() {
  const ctx = createContext(data);
  const pogs = await onlinePogs(ctx.gameServerId);
  console.log(`playtime-tick: ${pogs.length} online player(s)`);

  for (const pog of pogs) {
    ctx._pogs[pog.playerId] = pog;
    try {
      // Also hands out today's quests to online players who have none yet.
      const record = await ensureToday(ctx, pog.playerId);
      const state = record.state;
      const hasPlaytime = state.quests.some((q) => q.type === 'playtime' && !q.done);
      let minutes = 0;
      let dirty = false;
      if (hasPlaytime && (ctx.config.enabledTypes || {}).playtime !== false) {
        const last = state.lastTick ? new Date(state.lastTick).getTime() : 0;
        const gap = ctx.now.getTime() - last;
        // A long gap means the player was offline in between: start counting again from now.
        if (last > 0 && gap > 0 && gap <= MAX_TICK_GAP_MS) minutes = gap / 60000;
        state.lastTick = ctx.now.toISOString();
        dirty = true;
      }
      await trackProgress(ctx, pog.playerId, 'playtime', minutes, () => true, { record, dirty });
    } catch (err) {
      console.error(`playtime-tick: failed for player ${pog.playerId}: ${err}`);
    }
  }
}

await main();
