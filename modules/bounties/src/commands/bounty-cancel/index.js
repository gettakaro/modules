import { data, takaro, TakaroUserError } from '@takaro/helpers';
import { getBounty, saveBounty, getSettings, getPlayerName, feeOf, isExpired } from './bounty-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  const config = mod.userConfig;
  const { currency, prefix } = await getSettings(gameServerId);

  const target = args.target;
  if (!target || !target.playerId) {
    throw new TakaroUserError(`Usage: ${prefix}bountycancel <player>. Player not found.`);
  }

  const bounty = await getBounty(gameServerId, mod.moduleId, target.playerId);
  const mine = bounty ? bounty.entries.filter((e) => e.placerId === pog.playerId) : [];
  if (mine.length === 0) {
    const name = bounty ? bounty.targetName : await getPlayerName(target.playerId, 'that player');
    throw new TakaroUserError(`You have no active bounty on ${name}.`);
  }

  const now = new Date();
  let amount = 0;
  let fee = 0;
  for (const entry of mine) {
    amount += entry.amount;
    // An expired stake is the server's delay, not the player's choice: refund it in full.
    if (!isExpired(entry, config.expiryDays, now)) fee += feeOf(entry.amount, config.cancelFeePercent);
  }
  fee = Math.min(fee, amount);
  const refund = amount - fee;

  // Remove first so the stake cannot be claimed and refunded at the same time.
  bounty.entries = bounty.entries.filter((e) => e.placerId !== pog.playerId);
  await saveBounty(gameServerId, mod.moduleId, bounty);

  if (refund > 0) {
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, pog.playerId, {
      currency: refund,
    });
  }

  const feeText = fee > 0 ? ` (${fee} ${currency} cancel fee kept)` : '';
  await pog.pm(`Your bounty on ${bounty.targetName} is cancelled. ${refund} ${currency} refunded${feeText}.`);
}

await main();
