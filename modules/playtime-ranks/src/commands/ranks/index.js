import { data } from '@takaro/helpers';
import { createContext, getLadder, sendPm } from './rank-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod } = data;
  const ladder = getLadder(mod.userConfig);

  if (ladder.length === 0) {
    await sendPm(gameServerId, pog.gameId, 'No playtime ranks are configured on this server.');
    return;
  }

  const ctx = createContext(gameServerId);
  const currency = await ctx.currencyName();
  const prefix = await ctx.prefix();
  const lines = ladder.map((r) => `${r.name}: ${r.hours} h${r.reward > 0 ? ` (+${r.reward} ${currency})` : ''}`);

  await sendPm(gameServerId, pog.gameId, `Playtime ranks: ${lines.join(' > ')}. Type ${prefix}rank to see your progress.`);
}

await main();
