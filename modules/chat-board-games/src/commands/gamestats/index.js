import { data, TakaroUserError } from '@takaro/helpers';
import { getTexts, chatWords, listStats, getStats, pickByName, GAMES } from './cbg-helpers.js';

function record(s) {
  return `${s.wins ?? 0} wins, ${s.losses ?? 0} losses, ${s.draws ?? 0} draws`;
}

async function main() {
  const { player, gameServerId, module: mod } = data;
  const { prefix, currency } = await getTexts(gameServerId);
  const name = chatWords().join(' ');

  let stats;
  let who;
  if (name) {
    const all = await listStats(gameServerId, mod.moduleId);
    const hit = pickByName(all.map((r) => ({ ...r, name: r.stats.name })), name, 'player with board game stats');
    stats = hit.stats;
    who = hit.stats.name;
  } else {
    const mine = await getStats(gameServerId, mod.moduleId, player.id);
    if (!mine) throw new TakaroUserError(`You have not finished a board game yet. Try ${prefix}challenge <player> <game> [bet].`);
    stats = mine.stats;
    who = 'You';
  }
  const net = Number(stats.net) || 0;
  await player.pm(`${who}: ${record(stats)}. Bets: ${net >= 0 ? '+' : ''}${net} ${currency}.`);
  for (const g of Object.values(GAMES)) {
    const s = stats.games?.[g.id];
    if (s) await player.pm(`${g.name}: ${record(s)}`);
  }
}

await main();
