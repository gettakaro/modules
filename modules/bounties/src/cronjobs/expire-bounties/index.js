import { data } from '@takaro/helpers';
import { listBounties, saveBounty, refund, getSettings, isExpired } from './bounty-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig;
  if (!config.expiryDays || config.expiryDays <= 0) return;

  const now = new Date();
  const bounties = await listBounties(gameServerId, mod.moduleId);
  const { currency } = await getSettings(gameServerId);
  let refunded = 0;

  for (const bounty of bounties) {
    const expired = bounty.entries.filter((e) => isExpired(e, config.expiryDays, now));
    if (expired.length === 0) continue;

    bounty.entries = bounty.entries.filter((e) => !isExpired(e, config.expiryDays, now));
    await saveBounty(gameServerId, mod.moduleId, bounty);

    for (const entry of expired) {
      try {
        await refund(
          gameServerId,
          entry,
          entry.amount,
          `Nobody claimed your bounty on ${bounty.targetName}. ${entry.amount} ${currency} refunded.`,
        );
        refunded++;
      } catch (err) {
        console.error(`bounties: refund of ${entry.amount} to ${entry.placerId} failed: ${err}`);
      }
    }
  }
  console.log(`bounties: refunded ${refunded} expired stakes`);
}

await main();
