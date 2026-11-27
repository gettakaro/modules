import { data, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  cfg,
  getTexts,
  chatWords,
  enabledGames,
  listGames,
  pickByName,
  claimEnd,
  finishGame,
  gameName,
  potText,
} from './cbg-helpers.js';

async function main() {
  const { player, pog, gameServerId, module: mod } = data;
  const c = cfg(mod.userConfig);
  const texts = await getTexts(gameServerId);
  const { prefix, currency } = texts;
  const [action, ...rest] = chatWords();
  const act = String(action ?? '').toLowerCase();

  if (!act || act === 'help') {
    const games = enabledGames(c).map((g) => `${g.aliases[0]} (${g.name})`).join(', ');
    await player.pm(`Board games: ${games || 'none enabled'}.`);
    await player.pm(`${prefix}challenge <player> <game> [bet] - challenge someone, bet is optional.`);
    await player.pm(`${prefix}accept or ${prefix}decline - answer a challenge.`);
    await player.pm(`${prefix}move <square|column|rock|paper|scissors> - play. ${prefix}board shows the game.`);
    await player.pm(`${prefix}forfeit - give up or withdraw. ${prefix}gamestats and ${prefix}gametop - stats.`);
    if (c.maxBet > 0) await player.pm(`Bets are held until the game ends (max ${c.maxBet} ${currency}). Expired or declined challenges are refunded.`);
    return;
  }

  if (act !== 'list' && act !== 'cancel') throw new TakaroUserError(`Unknown option "${action}". Use ${prefix}boardgames, list or cancel <player>.`);
  if (!checkPermission(pog, 'BOARD_GAMES_MANAGE')) throw new TakaroUserError('You do not have permission to manage board games.');

  const games = await listGames(gameServerId, mod.moduleId);
  if (act === 'list') {
    if (games.length === 0) {
      await player.pm('No board games are running.');
      return;
    }
    await player.pm(`${games.length} board game${games.length === 1 ? '' : 's'}:`);
    for (const { game } of games) {
      await player.pm(`${game.challengerName} vs ${game.opponentName}: ${gameName(game)}, ${game.status}.${potText(game, currency)}`);
    }
    return;
  }

  const name = rest.join(' ');
  if (!name) throw new TakaroUserError(`Usage: ${prefix}boardgames cancel <player>`);
  const candidates = games.flatMap(({ variable, game }) => [
    { name: game.challengerName, variable, game },
    { name: game.opponentName, variable, game },
  ]);
  const hit = pickByName(candidates, name, 'player in a board game');
  if (!(await claimEnd(hit.variable))) throw new TakaroUserError('That game already ended.');
  const text = `An admin cancelled your ${gameName(hit.game)} game.`;
  await finishGame(gameServerId, mod, hit.game, { refund: true, messages: { challenger: text, opponent: text } }, texts);
  await player.pm(`Cancelled ${hit.game.challengerName} vs ${hit.game.opponentName}. Stakes refunded.`);
}

await main();
