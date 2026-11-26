import { data, TakaroUserError } from '@takaro/helpers';
import { cfg, getTexts, chatWords, listStats, findGame } from './cbg-helpers.js';

async function main() {
  const { player, gameServerId, module: mod } = data;
  const c = cfg(mod.userConfig);
  const { prefix } = await getTexts(gameServerId);
  const word = chatWords()[0];
  const game = word ? findGame(word) : null;
  if (word && !game) throw new TakaroUserError(`Unknown game "${word}". Use ttt, c4 or rps, or nothing for all games.`);

  const rows = (await listStats(gameServerId, mod.moduleId))
    .map(({ stats }) => {
      const s = game ? stats.games?.[game.id] : stats;
      return s ? { name: stats.name, wins: s.wins ?? 0, losses: s.losses ?? 0, draws: s.draws ?? 0 } : null;
    })
    .filter((r) => r && r.wins + r.losses + r.draws > 0)
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, c.leaderboardSize));

  if (rows.length === 0) {
    await player.pm(`No finished games yet. Be the first: ${prefix}challenge <player> <game> [bet]`);
    return;
  }
  await player.pm(`Board games top ${rows.length}${game ? ` (${game.name})` : ''}:`);
  for (const [i, r] of rows.entries()) {
    await player.pm(`${i + 1}. ${r.name} - ${r.wins} wins, ${r.losses} losses, ${r.draws} draws`);
  }
}

await main();
