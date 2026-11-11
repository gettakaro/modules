import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getBounty,
  listBounties,
  saveBounty,
  getSettings,
  getPlayerName,
  broadcast,
  feeOf,
  potOf,
  isExpired,
} from './bounty-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;
  const { currency, prefix } = await getSettings(gameServerId);
  const usage = `Usage: ${prefix}bounty <player> <amount>`;

  const permission = checkPermission(pog, 'BOUNTIES_PLACE');
  if (!permission) {
    throw new TakaroUserError('You do not have permission to place bounties.');
  }

  const target = args.target;
  if (!target || !target.playerId) {
    throw new TakaroUserError(`${usage}. Player not found.`);
  }
  if (target.playerId === pog.playerId) {
    throw new TakaroUserError('You cannot put a bounty on yourself.');
  }

  const amount = args.amount;
  if (!Number.isInteger(amount) || amount < 1) {
    throw new TakaroUserError(`${usage}. The amount must be a whole number.`);
  }
  if (amount < config.minAmount) {
    throw new TakaroUserError(`The minimum bounty is ${config.minAmount} ${currency}.`);
  }

  const now = new Date();

  // Count limit: number of different targets this player has an active stake on.
  const limit = typeof permission === 'object' && permission.count > 0 ? permission.count : 0;
  if (limit > 0) {
    const all = await listBounties(gameServerId, moduleId);
    const activeTargets = all.filter(
      (b) =>
        b.playerId !== target.playerId &&
        b.entries.some((e) => e.placerId === pog.playerId && !isExpired(e, config.expiryDays, now)),
    ).length;
    if (activeTargets >= limit) {
      throw new TakaroUserError(`You can have bounties on at most ${limit} players at once.`);
    }
  }

  const fee = feeOf(amount, config.placementFeePercent);
  const total = amount + fee;
  if ((pog.currency || 0) < total) {
    const feeText = fee > 0 ? ` (${amount} + ${fee} fee)` : '';
    throw new TakaroUserError(`You need ${total} ${currency}${feeText}, but you only have ${pog.currency || 0}.`);
  }

  // Take the money first: if this fails nothing is stored.
  try {
    await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, pog.playerId, {
      currency: total,
    });
  } catch (err) {
    console.error(`bounty: deduct failed: ${err}`);
    throw new TakaroUserError(`Could not take ${total} ${currency} from your balance. Nothing was placed.`);
  }

  const targetName = await getPlayerName(target.playerId, 'Unknown');
  let pot;
  try {
    const bounty = (await getBounty(gameServerId, moduleId, target.playerId)) || {
      playerId: target.playerId,
      entries: [],
    };
    bounty.targetName = targetName;
    const mine = bounty.entries.find((e) => e.placerId === pog.playerId);
    if (mine) {
      mine.amount += amount;
      mine.placedAt = now.toISOString();
      mine.placerName = player.name;
    } else {
      bounty.entries.push({ placerId: pog.playerId, placerName: player.name, amount, placedAt: now.toISOString() });
    }
    await saveBounty(gameServerId, moduleId, bounty);
    pot = potOf(bounty.entries.filter((e) => !isExpired(e, config.expiryDays, now)));
  } catch (err) {
    console.error(`bounty: storing failed, refunding ${total}: ${err}`);
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, pog.playerId, {
      currency: total,
    });
    throw new TakaroUserError('Could not save the bounty. Your money was refunded.');
  }

  const feeText = fee > 0 ? ` (plus a ${fee} ${currency} fee)` : '';
  const expiryText = config.expiryDays > 0 ? ` It is refunded if nobody claims it within ${config.expiryDays} days.` : '';
  await pog.pm(`You put ${amount} ${currency} on ${targetName}${feeText}. Total pot: ${pot} ${currency}.${expiryText}`);

  if (config.broadcastNewBounties) {
    await broadcast(gameServerId, `${player.name} put a ${amount} ${currency} bounty on ${targetName}! Total pot: ${pot} ${currency}.`);
  }
}

await main();
