import { data } from '@takaro/helpers';
import {
  cfg,
  getTexts,
  listGames,
  claimEnd,
  finishGame,
  playerByMark,
  getRpsPick,
  getReminder,
  setReminder,
  pmGameId,
  moveHint,
  gameName,
  minutesSince,
} from './cbg-helpers.js';

/** Who still has to move: a list of { id, name, gameId }. */
async function waitingPlayers(gameServerId, moduleId, game) {
  if (game.game !== 'rps') return [playerByMark(game, game.turn)];
  const out = [];
  for (const mark of ['X', 'O']) {
    const p = playerByMark(game, mark);
    const pick = await getRpsPick(gameServerId, moduleId, p.id, game.id);
    if (!pick || pick.pick.round !== game.round) out.push(p);
  }
  return out;
}

async function main() {
  const { gameServerId, module: mod } = data;
  const c = cfg(mod.userConfig);
  const texts = await getTexts(gameServerId);
  const games = await listGames(gameServerId, mod.moduleId);
  const now = Date.now();

  for (const { variable, game } of games) {
    try {
      const name = gameName(game);
      if (game.status === 'pending') {
        if (minutesSince(game.createdAt, now) < c.challengeTimeoutMinutes) continue;
        if (!(await claimEnd(variable))) continue;
        await finishGame(gameServerId, mod, game, {
          refund: true,
          messages: {
            challenger: `${game.opponentName} did not answer your ${name} challenge in time.`,
            opponent: `The ${name} challenge from ${game.challengerName} expired.`,
          },
        }, texts);
        continue;
      }

      const idle = minutesSince(game.lastMoveAt, now);
      const waiting = await waitingPlayers(gameServerId, mod.moduleId, game);
      if (idle >= c.turnTimeoutMinutes) {
        if (!(await claimEnd(variable))) continue;
        if (c.turnTimeoutAction === 'refund' || waiting.length !== 1) {
          const text = waiting.length === 2
            ? `Nobody moved in time, the ${name} game was cancelled.`
            : `${waiting[0]?.name ?? 'A player'} did not move in time, the ${name} game was cancelled.`;
          await finishGame(gameServerId, mod, game, { refund: true, messages: { challenger: text, opponent: text } }, texts);
        } else {
          const late = waiting[0];
          const winnerId = late.id === game.challengerId ? game.opponentId : game.challengerId;
          await finishGame(gameServerId, mod, game, { winnerId, reason: `${late.name} ran out of time` }, texts);
        }
        continue;
      }

      if (c.reminderMinutes > 0 && idle >= c.reminderMinutes) {
        const sent = await getReminder(gameServerId, mod.moduleId, game.challengerId);
        if (sent && sent.value?.gameId === game.id && sent.value?.at === game.lastMoveAt) continue;
        const left = Math.max(1, Math.ceil(c.turnTimeoutMinutes - idle));
        for (const p of waiting) {
          await pmGameId(gameServerId, p.gameId, `Your move in ${name}: ${moveHint(game, texts.prefix)} (${left} min left, ${texts.prefix}board shows the game).`);
        }
        await setReminder(gameServerId, mod.moduleId, game.challengerId, { gameId: game.id, at: game.lastMoveAt });
      }
    } catch (err) {
      console.log(`chat-board-games: tick failed for game ${game.id}: ${err}`);
    }
  }
}

await main();
