import { data } from '@takaro/helpers';
import {
  JAIL_KEY,
  getPoint,
  getRecord,
  isExpired,
  releasePlayer,
  tryTeleport,
  pmPlayer,
  formatRemaining,
  getPrefix,
} from './jail-helpers.js';

// Best effort: some games are not ready to teleport right at connect. The cron job retries every minute.
async function main() {
  const playerId = data.player?.id;
  if (!playerId) return;
  const record = await getRecord(playerId);
  if (!record) return;
  const gameId = data.pog?.gameId ?? data.eventData?.player?.gameId;

  if (record.status === 'pendingRelease' || isExpired(record)) {
    await releasePlayer(record, { online: true, gameId, reasonText: 'Your jail time is over.' });
    return;
  }

  const jail = await getPoint(JAIL_KEY);
  if (jail) {
    await tryTeleport(playerId, jail);
  }
  if (gameId) {
    const prefix = await getPrefix();
    await pmPlayer(gameId, `You are still in jail (${formatRemaining(record)}). Reason: ${record.reason}. Type ${prefix}jailtime for details.`);
  }
}

await main();
