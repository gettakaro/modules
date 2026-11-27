import { data, TakaroUserError } from '@takaro/helpers';
import { getTexts, findGameOf, claimEnd, finishGame, side } from './cbg-helpers.js';

async function main() {
  const { player, gameServerId, module: mod } = data;
  const texts = await getTexts(gameServerId);

  const found = await findGameOf(gameServerId, mod.moduleId, player.id);
  if (!found) throw new TakaroUserError('You are not in a game.');
  const { variable, game } = found;
  if (!(await claimEnd(variable))) throw new TakaroUserError('That game already ended.');

  if (game.status === 'pending') {
    // Withdrawing your own challenge, or refusing one aimed at you: nobody loses, the stake comes back.
    const mine = game.challengerId === player.id;
    await finishGame(gameServerId, mod, game, {
      refund: true,
      messages: mine
        ? { challenger: `You withdrew your challenge to ${game.opponentName}.`, opponent: `${game.challengerName} withdrew the challenge.` }
        : { challenger: `${game.opponentName} declined your challenge.`, opponent: `You declined the challenge from ${game.challengerName}.` },
    }, texts);
    return;
  }
  const { other } = side(game, player.id);
  await finishGame(gameServerId, mod, game, { winnerId: other.id, reason: `${player.name} forfeited` }, texts);
}

await main();
