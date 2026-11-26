import { data, TakaroUserError } from '@takaro/helpers';
import { cfg, getTexts, findGameOf, sendBoard, side, gameName, potText, moveHint, getRpsPick, minutesSince } from './cbg-helpers.js';

async function main() {
  const { player, pog, gameServerId, module: mod } = data;
  const c = cfg(mod.userConfig);
  const { prefix, currency } = await getTexts(gameServerId);

  const found = await findGameOf(gameServerId, mod.moduleId, player.id);
  if (!found) throw new TakaroUserError(`You are not in a game. Start one with ${prefix}challenge <player> <game> [bet].`);
  const { game } = found;
  const { mark, other } = side(game, player.id);
  const name = gameName(game);

  if (game.status === 'pending') {
    const left = Math.max(0, Math.ceil(c.challengeTimeoutMinutes - minutesSince(game.createdAt)));
    const text = game.challengerId === player.id
      ? `Your ${name} challenge to ${other.name} is waiting (${left} min left).${potText(game, currency)}`
      : `${other.name} challenged you to ${name}.${potText(game, currency)} Type ${prefix}accept or ${prefix}decline (${left} min left).`;
    await player.pm(text);
    return;
  }

  const left = Math.max(0, Math.ceil(c.turnTimeoutMinutes - minutesSince(game.lastMoveAt)));
  if (game.game === 'rps') {
    const mine = await getRpsPick(gameServerId, mod.moduleId, player.id, game.id);
    const picked = mine && mine.pick.round === game.round ? `You picked ${mine.pick.pick}.` : `Your pick: ${moveHint(game, prefix)}`;
    const myScore = game.score?.[mark] ?? 0;
    const theirScore = game.score?.[mark === 'X' ? 'O' : 'X'] ?? 0;
    await player.pm(`${name} vs ${other.name}, round ${game.round}, score ${myScore}-${theirScore}.${potText(game, currency)}`);
    await player.pm(`${picked} ${left} min left.`);
    return;
  }
  const status = game.turn === mark
    ? `Your turn (${mark}) vs ${other.name}: ${moveHint(game, prefix)} (${left} min left)`
    : `Waiting for ${other.name}. You are ${mark}.`;
  await player.pm(`${name} vs ${other.name}.${potText(game, currency)}`);
  await sendBoard(gameServerId, game, pog.gameId, status);
}

await main();
