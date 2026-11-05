import { takaro, data, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  requireCrate,
  getPrefix,
  getCurrencyName,
  parseCount,
  getKeys,
  addKeys,
  rollReward,
  rarityRank,
  giveReward,
  fillTemplate,
  argValue,
} from './crate-helpers.js';

async function buy(ctx, crateName, rawAmount) {
  const { config, gameServerId, pog, moduleId, prefix, currencyName } = ctx;
  const crate = requireCrate(config, crateName, prefix);
  const price = Number(crate.keyPrice) || 0;
  if (price <= 0) {
    throw new TakaroUserError(`${crate.name} keys cannot be bought with ${currencyName}. Check the server shop.`);
  }
  const max = Number(config.maxKeysPerPurchase) || 10;
  const amount = parseCount(rawAmount, 1);
  if (!Number.isInteger(amount) || amount < 1 || amount > max) {
    throw new TakaroUserError(`Amount must be a whole number from 1 to ${max}. Usage: ${prefix}crate buy ${crate.name} [amount]`);
  }

  const discountPerm = checkPermission(pog, 'LOOT_CRATES_KEY_DISCOUNT');
  const discount = discountPerm && typeof discountPerm.count === 'number' ? Math.min(100, Math.max(0, discountPerm.count)) : 0;
  const total = Math.max(0, Math.round(price * amount * (1 - discount / 100)));

  const fresh = (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, pog.playerId)).data.data;
  if ((fresh.currency || 0) < total) {
    throw new TakaroUserError(`You need ${total} ${currencyName} for ${amount} ${crate.name} key(s). You have ${fresh.currency || 0}.`);
  }
  if (total > 0) {
    await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, pog.playerId, { currency: total });
  }
  const keys = await addKeys(crate, gameServerId, pog.playerId, moduleId, amount);
  const discountText = discount > 0 ? ` (${discount}% off)` : '';
  await pog.pm(
    `Bought ${amount} ${crate.name} key(s) for ${total} ${currencyName}${discountText}. You have ${keys}. Open with ${prefix}crate open ${crate.name}`,
  );
}

async function open(ctx, crateName) {
  const { config, gameServerId, pog, player, moduleId, prefix, currencyName } = ctx;
  const crate = requireCrate(config, crateName, prefix);
  const keys = await getKeys(crate, gameServerId, pog.playerId, moduleId);
  if (keys < 1) {
    const how = Number(crate.keyPrice) > 0 ? ` Buy one: ${prefix}crate buy ${crate.name}` : '';
    throw new TakaroUserError(`You have no ${crate.name} keys.${how}`);
  }

  const reward = rollReward(crate);
  const left = await addKeys(crate, gameServerId, pog.playerId, moduleId, -1);

  let result;
  try {
    result = await giveReward(reward, gameServerId, pog.playerId, currencyName);
  } catch (error) {
    await addKeys(crate, gameServerId, pog.playerId, moduleId, 1);
    console.error(`loot-crates: reward failed, key refunded: ${error}`);
    throw new TakaroUserError('Something went wrong giving your reward. Your key was refunded, try again later.');
  }

  if (result.given.length === 0 && result.failed.length > 0) {
    await addKeys(crate, gameServerId, pog.playerId, moduleId, 1);
    throw new TakaroUserError(
      `Your reward could not be given (${result.failed.join(', ')}). Your key was refunded. Tell an admin if this keeps happening.`,
    );
  }

  const rarity = reward.rarity || 'common';
  let message = `[${rarity.toUpperCase()}] ${reward.name}: ${result.given.join(' + ')}. ${crate.name} keys left: ${left}.`;
  if (result.failed.length > 0) {
    message += ` Not delivered: ${result.failed.join(', ')}. Please tell an admin.`;
  }
  await pog.pm(message);

  const min = config.broadcastMinRarity || 'rare';
  if (min !== 'never' && rarityRank(rarity) >= rarityRank(min)) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: fillTemplate(config.broadcastMessage || '{player} opened a {crate} crate and got {reward} ({rarity})!', {
        player: player.name,
        crate: crate.name,
        reward: reward.name,
        rarity,
      }),
    });
  }
}

async function findTargetPlayer(gameServerId, name) {
  const wanted = String(name || '').trim();
  let candidates = (await takaro.player.playerControllerSearch({ filters: { name: [wanted] } })).data.data;
  if (candidates.length === 0) {
    candidates = (await takaro.player.playerControllerSearch({ search: { name: [wanted] } })).data.data;
  }
  const onServer = [];
  for (const candidate of candidates) {
    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, candidate.id);
      onServer.push(candidate);
    } catch {
      // not on this server
    }
  }
  if (onServer.length === 0) {
    throw new TakaroUserError(`No player called "${wanted}" found on this server.`);
  }
  const exact = onServer.filter((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (onServer.length > 1) {
    throw new TakaroUserError(`"${wanted}" matches several players: ${onServer.map((p) => p.name).join(', ')}. Be more exact.`);
  }
  return onServer[0];
}

async function giveKey(ctx, targetName, crateName, rawAmount) {
  const { config, gameServerId, pog, moduleId, prefix } = ctx;
  if (!checkPermission(pog, 'LOOT_CRATES_MANAGE')) {
    throw new TakaroUserError('You do not have permission to give crate keys.');
  }
  if (!String(targetName || '').trim()) {
    throw new TakaroUserError(`Usage: ${prefix}crate givekey <player> <crate> [amount]`);
  }
  const crate = requireCrate(config, crateName, prefix);
  const amount = parseCount(rawAmount, 1);
  if (!Number.isInteger(amount) || amount < 1 || amount > 1000) {
    throw new TakaroUserError('Amount must be a whole number from 1 to 1000.');
  }
  const target = await findTargetPlayer(gameServerId, targetName);
  const keys = await addKeys(crate, gameServerId, target.id, moduleId, amount);
  await pog.pm(`Gave ${amount} ${crate.name} key(s) to ${target.name}. They now have ${keys}.`);

  const targetPog = (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, target.id)).data.data;
  if (targetPog.online && targetPog.gameId && target.id !== pog.playerId) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: `You received ${amount} ${crate.name} crate key(s)! Open with ${prefix}crate open ${crate.name}`,
      opts: { recipient: { gameId: targetPog.gameId } },
    });
  }
}

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod } = data;
  const prefix = await getPrefix(gameServerId);
  const currencyName = await getCurrencyName(gameServerId);
  const ctx = { config: mod.userConfig, gameServerId, pog, player, moduleId: mod.moduleId, prefix, currencyName };
  const action = argValue(args.action).toLowerCase();
  const first = argValue(args.first);
  const second = argValue(args.second);
  const third = argValue(args.third);

  switch (action) {
    case 'buy':
      return buy(ctx, first, second);
    case 'open':
      return open(ctx, first);
    case 'givekey':
      return giveKey(ctx, first, second, third);
    default:
      throw new TakaroUserError(
        `Usage: ${prefix}crate buy <name> [amount], ${prefix}crate open <name>. See all crates: ${prefix}crates`,
      );
  }
}

await main();
