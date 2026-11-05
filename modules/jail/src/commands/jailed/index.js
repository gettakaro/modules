import { data, checkPermission } from '@takaro/helpers';
import { listRecords, formatRemaining, requireManage } from './jail-helpers.js';

async function main() {
  requireManage(checkPermission);
  const records = (await listRecords()).filter((r) => r.status === 'jailed');

  if (records.length === 0) {
    await data.player.pm('Nobody is in jail.');
    return;
  }

  await data.player.pm(`In jail (${records.length}):`);
  for (const r of records) {
    await data.player.pm(`- ${r.name}: ${formatRemaining(r)} left. Reason: ${r.reason} (by ${r.by})`);
  }
}

await main();
