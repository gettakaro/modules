import { data, TakaroUserError } from '@takaro/helpers';
import {
  cfg,
  getTexts,
  findGameOf,
  takeStake,
  addCurrency,
  saveGame,
  pmGameId,
  announceTurn,
  gameName,
  potText,
  moveHint,
} from './cbg-helpers.js';

async function main() {
  const { player, pog, gameServerId, module: mod } = data;
  const c = cfg(mod.userConfig);
  const { prefix, currency } = await getTexts(gameServerId);

  const found = await findGameOf(gameServerId, mod.moduleId, player.id);
  if (!found || found.game.status !== 'pending' || found.game.opponentId !== player.id) {
    if (found && found.game.status === 'active') throw new TakaroUserError(`You are already in a game. See it with ${prefix}board.`);
    throw new TakaroUserError('You have no open challenge to accept.');
  }
  const { variable, game } = found;
  const bet = Number(game.bet) || 0;
  if (bet > 0 && (Number(pog.currency) || 0) < bet) {
    throw new TakaroUserError(`You need ${bet} ${currency} to accept. Type ${prefix}decline to refuse.`);
  }
  if (!(await takeStake(gameServerId, player.id, bet))) {
    throw new TakaroUserError(`You need ${bet} ${currency} to accept. Type ${prefix}decline to refuse.`);
  }

  // Random first player; the starter plays X.
  const challengerStarts = Math.random() < 0.5;
  game.status = 'active';
  game.challengerMark = challengerStarts ? 'X' : 'O';
  game.turn = 'X';
  game.round = 1;
  game.score = { X: 0, O: 0 };
  game.acceptedAt = new Date().toISOString();
  game.lastMoveAt = game.acceptedAt;
  if (!(await saveGame(variable, game))) {
    await addCurrency(gameServerId, player.id, bet);
    throw new TakaroUserError('That challenge just expired.');
  }

  const xName = challengerStarts ? game.challengerName : game.opponentName;
  const oName = challengerStarts ? game.opponentName : game.challengerName;
  const name = gameName(game);
  if (game.game === 'rps') {
    const bo = c.rpsBestOf > 1 ? ` Best of ${c.rpsBestOf}.` : '';
    const line = `Game on: ${name}, ${game.challengerName} vs ${game.opponentName}.${potText(game, currency)}${bo}`;
    for (const gid of [game.challengerGameId, game.opponentGameId]) {
      await pmGameId(gameServerId, gid, line);
      await pmGameId(gameServerId, gid, `Pick in secret: ${moveHint(game, prefix)}`);
    }
    return;
  }
  const line = `Game on: ${name}, ${xName} (X) vs ${oName} (O).${potText(game, currency)} X starts.`;
  await pmGameId(gameServerId, game.challengerGameId, line);
  await pmGameId(gameServerId, game.opponentGameId, line);
  await announceTurn(gameServerId, game, prefix);
}

await main();
