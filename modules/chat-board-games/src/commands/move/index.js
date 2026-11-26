import { data, TakaroUserError } from '@takaro/helpers';
import {
  cfg,
  getTexts,
  chatWords,
  findGameOf,
  saveGame,
  claimEnd,
  finishGame,
  side,
  applyMove,
  boardResult,
  playerByMark,
  announceTurn,
  pmGameId,
  moveHint,
  parseRpsPick,
  rpsCompare,
  getRpsPick,
  setRpsPick,
} from './cbg-helpers.js';

async function playRps(game, variable, me, texts) {
  const { player, gameServerId, module: mod } = data;
  const c = cfg(mod.userConfig);
  const { prefix } = texts;
  const pick = parseRpsPick(chatWords()[0]);
  if (!pick) throw new TakaroUserError(`Pick one: ${moveHint(game, prefix)}`);

  const mine = await getRpsPick(gameServerId, mod.moduleId, player.id, game.id);
  if (mine && mine.pick.round === game.round) throw new TakaroUserError(`You already picked ${mine.pick.pick} this round.`);
  await setRpsPick(gameServerId, mod.moduleId, player.id, game.id, game.round, pick);

  const theirs = await getRpsPick(gameServerId, mod.moduleId, me.other.id, game.id);
  if (!theirs || theirs.pick.round !== game.round) {
    await player.pm(`You picked ${pick}. Waiting for ${me.other.name}.`);
    await pmGameId(gameServerId, me.other.gameId, `${player.name} has picked. Your pick: ${moveHint(game, prefix)}`);
    return;
  }

  const otherPick = theirs.pick.pick;
  const res = rpsCompare(pick, otherPick);
  const reveal = `${player.name}: ${pick}, ${me.other.name}: ${otherPick}.`;
  const myGameId = data.pog.gameId;
  const otherMark = me.mark === 'X' ? 'O' : 'X';
  game.score = game.score ?? { X: 0, O: 0 };

  if (res === 0) {
    game.round += 1;
    game.lastMoveAt = new Date().toISOString();
    if (!(await saveGame(variable, game))) throw new TakaroUserError('That game already ended.');
    for (const gid of [myGameId, me.other.gameId]) {
      await pmGameId(gameServerId, gid, `${reveal} Same pick, no point.`);
      await pmGameId(gameServerId, gid, `Pick again: ${moveHint(game, prefix)}`);
    }
    return;
  }

  const roundWinnerMark = res > 0 ? me.mark : otherMark;
  game.score[roundWinnerMark] = (game.score[roundWinnerMark] ?? 0) + 1;
  const need = Math.floor(Math.max(1, c.rpsBestOf) / 2) + 1;
  const roundWinner = res > 0 ? player.name : me.other.name;
  if (game.score[roundWinnerMark] >= need) {
    for (const gid of [myGameId, me.other.gameId]) await pmGameId(gameServerId, gid, reveal);
    if (!(await claimEnd(variable))) return;
    const winnerId = res > 0 ? player.id : me.other.id;
    await finishGame(gameServerId, mod, game, { winnerId, reason: need > 1 ? `${game.score[roundWinnerMark]}-${game.score[roundWinnerMark === 'X' ? 'O' : 'X']}` : `${res > 0 ? pick : otherPick} beats ${res > 0 ? otherPick : pick}` }, texts);
    return;
  }
  game.round += 1;
  game.lastMoveAt = new Date().toISOString();
  if (!(await saveGame(variable, game))) throw new TakaroUserError('That game already ended.');
  const myScore = game.score[me.mark];
  const theirScore = game.score[otherMark];
  await pmGameId(gameServerId, myGameId, `${reveal} ${roundWinner} wins the round. Score: you ${myScore}, ${me.other.name} ${theirScore}.`);
  await pmGameId(gameServerId, me.other.gameId, `${reveal} ${roundWinner} wins the round. Score: you ${theirScore}, ${player.name} ${myScore}.`);
  for (const gid of [myGameId, me.other.gameId]) await pmGameId(gameServerId, gid, `Next round: ${moveHint(game, prefix)}`);
}

async function main() {
  const { player, gameServerId, module: mod } = data;
  const texts = await getTexts(gameServerId);
  const { prefix } = texts;

  const found = await findGameOf(gameServerId, mod.moduleId, player.id);
  if (!found) throw new TakaroUserError(`You are not in a game. Start one with ${prefix}challenge <player> <game> [bet].`);
  const { variable, game } = found;
  if (game.status !== 'active') {
    throw new TakaroUserError(
      game.opponentId === player.id ? `Accept the challenge first with ${prefix}accept.` : `Waiting for ${game.opponentName} to accept.`,
    );
  }
  const me = side(game, player.id);
  if (game.game === 'rps') {
    await playRps(game, variable, me, texts);
    return;
  }

  if (game.turn !== me.mark) throw new TakaroUserError(`It is ${me.other.name}'s turn. You are ${me.mark}.`);
  const word = chatWords()[0];
  if (!word) throw new TakaroUserError(`Usage: ${moveHint(game, prefix)}`);
  const err = applyMove(game, me.mark, word);
  if (err) throw new TakaroUserError(err);

  const result = boardResult(game);
  if (result) {
    if (!(await claimEnd(variable))) throw new TakaroUserError('That game already ended.');
    if (result === 'draw') {
      await finishGame(gameServerId, mod, game, { draw: true }, texts);
    } else {
      await finishGame(gameServerId, mod, game, { winnerId: playerByMark(game, result).id }, texts);
    }
    return;
  }

  game.turn = me.mark === 'X' ? 'O' : 'X';
  game.lastMoveAt = new Date().toISOString();
  if (!(await saveGame(variable, game))) throw new TakaroUserError('That game already ended.');
  await pmGameId(gameServerId, me.other.gameId, `${player.name} played ${game.lastMove}.`);
  await announceTurn(gameServerId, game, prefix);
}

await main();
