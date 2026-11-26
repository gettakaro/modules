import { data, TakaroUserError } from '@takaro/helpers';
import { getTexts, findGameOf, claimEnd, finishGame } from './cbg-helpers.js';

async function main() {
  const { player, gameServerId, module: mod } = data;
  const texts = await getTexts(gameServerId);

  const found = await findGameOf(gameServerId, mod.moduleId, player.id);
  if (!found || found.game.status !== 'pending' || found.game.opponentId !== player.id) {
    throw new TakaroUserError('You have no open challenge to decline.');
  }
  const { variable, game } = found;
  if (!(await claimEnd(variable))) throw new TakaroUserError('That challenge is already gone.');
  await finishGame(gameServerId, mod, game, {
    refund: true,
    messages: {
      challenger: `${game.opponentName} declined your challenge.`,
      opponent: `You declined the challenge from ${game.challengerName}.`,
    },
  }, texts);
}

await main();
