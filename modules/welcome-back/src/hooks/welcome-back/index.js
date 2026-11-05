import { data, takaro, checkPermission } from '@takaro/helpers';
import {
  DAY_MS,
  LAST_KEY,
  NEW_PLAYER_GRACE_MS,
  daysBetween,
  fill,
  findVariable,
  getSetting,
  parseJson,
  pickTier,
  recordReturn,
  saveVariable,
  takeLock,
  toTime,
} from './welcome-back-helpers.js';

async function giveItems(gameServerId, playerId, items, multiplier) {
  const given = [];
  let failed = 0;
  // Sequential on purpose: the module sandbox caps concurrent outbound requests.
  for (const entry of items) {
    if (!entry || !entry.item) continue;
    const amount = Math.max(1, Math.round(Number(entry.amount || 1) * multiplier));
    try {
      await takaro.gameserver.gameServerControllerGiveItem(gameServerId, playerId, {
        name: entry.item,
        amount,
        ...(entry.quality ? { quality: entry.quality } : {}),
      });
      let name = entry.item;
      try {
        name = (await takaro.item.itemControllerFindOne(entry.item)).data.data.name || name;
      } catch {
        // Name lookup is cosmetic; keep the id.
      }
      given.push(`${amount}x ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`welcome-back: giving item ${entry.item} x${amount} failed: ${err}`);
    }
  }
  return { given, failed };
}

async function main() {
  const { gameServerId, player, pog, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;
  const nowMs = Date.now();
  const minDays = Number(config.minDaysAway) || 7;

  // In a player-connected payload, pog.lastSeen is still the end of the PREVIOUS session.
  const lastSeenMs = toTime(pog.lastSeen);
  const createdMs = toTime(pog.createdAt);
  if (lastSeenMs === null || (createdMs !== null && nowMs - createdMs < NEW_PLAYER_GRACE_MS)) {
    console.log(`welcome-back: ${player.name} is a new player, skipping (first join is onboarding's job)`);
    return;
  }

  const days = daysBetween(lastSeenMs, nowMs);
  if (days < minDays) {
    console.log(`welcome-back: ${player.name} was away ${days} days (< ${minDays}), nothing to do`);
    return;
  }

  if (!(await takeLock(gameServerId, moduleId, pog.playerId, nowMs))) {
    console.log(`welcome-back: duplicate connect event for ${player.name}, skipping`);
    return;
  }

  // Once per absence: an absence is identified by the lastSeen it started from.
  const lastVar = await findVariable(LAST_KEY, gameServerId, moduleId, pog.playerId);
  const last = parseJson(lastVar, null);
  if (last && toTime(last.lastSeen) === lastSeenMs) {
    console.log(`welcome-back: ${player.name} already handled for this absence`);
    return;
  }
  if (last && Number(last.at) && nowMs - Number(last.at) < minDays * DAY_MS) {
    console.log(`welcome-back: ${player.name} was welcomed back less than ${minDays} days ago, skipping`);
    return;
  }
  // Save before paying out, so a crash halfway can never pay the same absence twice.
  await saveVariable(lastVar, {
    key: LAST_KEY,
    value: JSON.stringify({ at: nowMs, lastSeen: new Date(lastSeenMs).toISOString(), days }),
    gameServerId,
    moduleId,
    playerId: pog.playerId,
  });

  const needsPrefix = [config.message, config.messageNoReward].some((m) => String(m || '').includes('{prefix}'));
  const currencyName = await getSetting('currencyName', gameServerId, 'coins');
  const prefix = needsPrefix ? await getSetting('commandPrefix', gameServerId, '/') : '/';

  const claim = checkPermission(pog, 'WELCOME_BACK_CLAIM');
  const parts = [];
  let paidCurrency = 0;
  let failedItems = 0;

  if (claim) {
    const multiplier = claim.count > 1 ? claim.count : 1;
    const tier = pickTier(config.tiers, days) || { currency: 0, itemMultiplier: 1 };

    const baseCurrency = Math.max(0, Math.round(Number(tier.currency || 0)));
    if (baseCurrency > 0) {
      const economyEnabled = String(await getSetting('economyEnabled', gameServerId, 'false')) === 'true';
      if (economyEnabled) {
        paidCurrency = baseCurrency * multiplier;
        await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, pog.playerId, {
          currency: paidCurrency,
          reason: `Welcome back after ${days} days`,
        });
        parts.push(`${paidCurrency} ${currencyName}`);
      } else {
        console.log('welcome-back: economy is disabled on this server, skipping the currency reward');
      }
    }

    const itemMultiplier = tier.itemMultiplier === undefined ? 1 : Number(tier.itemMultiplier);
    if (Array.isArray(config.items) && config.items.length > 0 && itemMultiplier > 0) {
      const { given, failed } = await giveItems(gameServerId, pog.playerId, config.items, itemMultiplier);
      parts.push(...given);
      failedItems = failed;
    }
  }

  const values = { player: player.name, days, currency: currencyName, prefix };
  if (parts.length > 0) {
    await pog.pm(fill(config.message, { ...values, reward: parts.join(' + ') }));
  } else if (config.messageNoReward) {
    await pog.pm(fill(config.messageNoReward, values));
  }
  if (failedItems > 0) {
    await pog.pm(`${failedItems} reward item(s) could not be delivered. Please contact an admin.`);
  }

  if (config.broadcast) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message: fill(config.broadcastMessage, values),
    });
  }

  await recordReturn(gameServerId, moduleId, nowMs, parts.length > 0, paidCurrency);
  console.log(
    `welcome-back: ${player.name} returned after ${days} days, reward=${parts.join(' + ') || 'none'}`,
  );
}

await main();
