import { data, TakaroUserError } from '@takaro/helpers';
import {
  cfg,
  getTexts,
  getSetting,
  chatWords,
  findGame,
  enabledGames,
  getOnlinePlayers,
  pickByName,
  findGameOf,
  takeStake,
  addCurrency,
  createGame,
  pmGameId,
  newBoard,
} from './cbg-helpers.js';

async function main() {
  const { player, pog, gameServerId, module: mod } = data;
  const c = cfg(mod.userConfig);
  const { prefix, currency } = await getTexts(gameServerId);
  const games = enabledGames(c);
  if (games.length === 0) throw new TakaroUserError('No board games are enabled on this server.');
  const gameList = games.map((g) => g.aliases[0]).join(', ');
  const usage = `Usage: ${prefix}challenge <player> <${games.map((g) => g.aliases[0]).join('|')}> [bet]`;

  // Read the full chat line: names can have spaces and Takaro passes text args as one word.
  const words = chatWords();
  let bet = 0;
  if (words.length > 1 && /^\d+$/.test(words[words.length - 1])) bet = Number(words.pop());

  let game = null;
  const gameIdx = words.findIndex((w) => findGame(w));
  if (gameIdx >= 0) {
    game = findGame(words[gameIdx]);
    words.splice(gameIdx, 1);
  } else if (games.length === 1) {
    game = games[0];
  }
  const targetName = words.join(' ');
  if (!game || !targetName) throw new TakaroUserError(usage);
  if (!c.enabled[game.id]) throw new TakaroUserError(`${game.name} is turned off here. Games: ${gameList}.`);

  if (bet > 0) {
    const economy = String(await getSetting('economyEnabled', gameServerId, 'true'));
    if (economy === 'false') throw new TakaroUserError('Bets need the economy, which is turned off. Play without a bet.');
    if (c.maxBet <= 0) throw new TakaroUserError('Bets are turned off on this server. Play without a bet.');
    if (bet < c.minBet) throw new TakaroUserError(`The minimum bet is ${c.minBet} ${currency}.`);
    if (bet > c.maxBet) throw new TakaroUserError(`The maximum bet is ${c.maxBet} ${currency}.`);
    if ((Number(pog.currency) || 0) < bet) throw new TakaroUserError(`You do not have ${bet} ${currency}.`);
  }

  const online = await getOnlinePlayers(gameServerId);
  const target = pickByName(online, targetName, 'online player');
  if (target.id === player.id) throw new TakaroUserError('You cannot challenge yourself.');

  const [mine, theirs] = [
    await findGameOf(gameServerId, mod.moduleId, player.id),
    await findGameOf(gameServerId, mod.moduleId, target.id),
  ];
  if (mine) {
    throw new TakaroUserError(
      mine.game.status === 'pending'
        ? `You already have an open challenge. Withdraw it with ${prefix}forfeit.`
        : `You are already in a game. See it with ${prefix}board or give up with ${prefix}forfeit.`,
    );
  }
  if (theirs) throw new TakaroUserError(`${target.name} is already in a game. Try again later.`);

  if (!(await takeStake(gameServerId, player.id, bet))) throw new TakaroUserError(`You do not have ${bet} ${currency}.`);

  const now = new Date().toISOString();
  const row = {
    id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    game: game.id,
    status: 'pending',
    bet,
    challengerId: player.id,
    challengerName: player.name,
    challengerGameId: pog.gameId,
    opponentId: target.id,
    opponentName: target.name,
    opponentGameId: target.gameId,
    createdAt: now,
    lastMoveAt: now,
    board: newBoard(game.id),
  };
  try {
    await createGame(gameServerId, mod.moduleId, row);
  } catch (err) {
    await addCurrency(gameServerId, player.id, bet);
    console.log(`chat-board-games: could not store challenge: ${err}`);
    throw new TakaroUserError('Could not create the challenge. Your stake was refunded. Please try again.');
  }

  const betText = bet > 0 ? ` for ${bet} ${currency} each (winner takes ${bet * 2})` : '';
  const mins = c.challengeTimeoutMinutes;
  await data.player.pm(`You challenged ${target.name} to ${game.name}${betText}. They have ${mins} min to accept.`);
  await pmGameId(gameServerId, target.gameId, `${player.name} challenges you to ${game.name}${betText}.`);
  await pmGameId(gameServerId, target.gameId, `Type ${prefix}accept or ${prefix}decline within ${mins} min.`);
}

await main();
