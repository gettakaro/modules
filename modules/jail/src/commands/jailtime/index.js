import { data } from '@takaro/helpers';
import { getRecord, formatRemaining } from './jail-helpers.js';

async function main() {
  const record = await getRecord(data.pog.playerId);
  if (!record || record.status !== 'jailed') {
    await data.player.pm('You are not in jail.');
    return;
  }
  const left = record.until === null ? formatRemaining(record) : `${formatRemaining(record)} left`;
  await data.player.pm(`You are in jail: ${left}. Reason: ${record.reason}`);
}

await main();
