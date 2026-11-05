import { data } from '@takaro/helpers';
import {
  JAIL_KEY,
  getPoint,
  listRecords,
  findPog,
  positionOf,
  distance,
  isExpired,
  releasePlayer,
  tryTeleport,
  pmPlayer,
  broadcast,
  formatRemaining,
} from './jail-helpers.js';

async function main() {
  const records = await listRecords();
  if (records.length === 0) return;

  const jail = await getPoint(JAIL_KEY);
  const radius = data.module.userConfig.radius;
  const now = new Date();

  // Sequential on purpose: keeps outbound requests well under the sandbox limit.
  for (const record of records) {
    const pog = await findPog(record.playerId);
    const online = Boolean(pog?.online);

    if (record.status === 'pendingRelease') {
      if (online) {
        await releasePlayer(record, { online, gameId: pog.gameId, reasonText: 'Your jail time is over.' });
      }
      continue;
    }

    if (isExpired(record, now)) {
      const result = await releasePlayer(record, {
        online,
        gameId: pog?.gameId,
        reasonText: 'Your jail time is over.',
      });
      console.log(`Jail time over for ${record.name}: ${result}`);
      await broadcast(`${record.name} has served their jail time.`);
      continue;
    }

    if (!online || !jail) continue;
    const position = positionOf(pog);
    if (!position) continue;

    if (distance(position, jail) > radius) {
      console.log(`${record.name} left the jail, teleporting back.`);
      if (await tryTeleport(record.playerId, jail)) {
        await pmPlayer(pog.gameId, `You cannot leave the jail. Time left: ${formatRemaining(record, now)}.`);
      }
    }
  }
}

await main();
