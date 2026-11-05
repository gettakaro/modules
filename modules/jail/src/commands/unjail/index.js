import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { getRecord, findPog, releasePlayer, broadcast, playerName, requireManage } from './jail-helpers.js';

async function main() {
  requireManage(checkPermission);
  const target = data.arguments.target;
  const name = await playerName(target.playerId);

  const record = await getRecord(target.playerId);
  if (!record || record.status !== 'jailed') {
    throw new TakaroUserError(`${name} is not in jail.`);
  }

  const pog = (await findPog(target.playerId)) ?? target;
  const result = await releasePlayer(record, {
    online: Boolean(pog.online),
    gameId: pog.gameId,
    reasonText: `Released by ${data.player.name}.`,
  });

  await broadcast(`${name} was released from jail.`);
  await data.player.pm(
    result === 'released'
      ? `${name} has been released.`
      : `${name} has been released. They will be moved out of jail when they are online.`,
  );
}

await main();
