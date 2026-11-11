import { takaro } from '@takaro/helpers';

// One variable per target: key BOUNTY_KEY, playerId = target, value = { targetName, entries }.
// Each entry is one placer's stake: { placerId, placerName, amount, placedAt }.
export const BOUNTY_KEY = 'bounty';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getSettings(gameServerId) {
  const read = async (key, fallback) => {
    try {
      const res = await takaro.settings.settingsControllerGetOne(key, gameServerId);
      return (res.data.data && res.data.data.value) || fallback;
    } catch (err) {
      console.error(`bounties: could not read setting ${key}: ${err}`);
      return fallback;
    }
  };
  const currency = await read('currencyName', 'coins');
  const prefix = await read('commandPrefix', '/');
  return { currency, prefix };
}

function parseValue(raw) {
  try {
    const value = JSON.parse(raw);
    if (value && Array.isArray(value.entries)) return value;
  } catch (err) {
    console.error(`bounties: ignoring unreadable bounty value: ${err}`);
  }
  return { targetName: 'Unknown', entries: [] };
}

export async function getBounty(gameServerId, moduleId, targetPlayerId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: { key: [BOUNTY_KEY], gameServerId: [gameServerId], moduleId: [moduleId], playerId: [targetPlayerId] },
  });
  const row = res.data.data[0];
  if (!row) return null;
  return { id: row.id, playerId: row.playerId, ...parseValue(row.value) };
}

export async function listBounties(gameServerId, moduleId) {
  const all = [];
  const limit = 100;
  for (let page = 0; page < 50; page++) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { key: [BOUNTY_KEY], gameServerId: [gameServerId], moduleId: [moduleId] },
      limit,
      page,
    });
    for (const row of res.data.data) {
      all.push({ id: row.id, playerId: row.playerId, ...parseValue(row.value) });
    }
    if (res.data.data.length < limit) break;
  }
  return all;
}

/** Writes the remaining entries back, or deletes the row when none are left. */
export async function saveBounty(gameServerId, moduleId, bounty) {
  const value = JSON.stringify({ targetName: bounty.targetName, entries: bounty.entries });
  if (bounty.entries.length === 0) {
    if (bounty.id) await takaro.variable.variableControllerDelete(bounty.id);
    return;
  }
  if (bounty.id) {
    await takaro.variable.variableControllerUpdate(bounty.id, { value });
  } else {
    await takaro.variable.variableControllerCreate({
      key: BOUNTY_KEY,
      value,
      gameServerId,
      moduleId,
      playerId: bounty.playerId,
    });
  }
}

/** The row may have been deleted by saveBounty; look it up again before writing. */
async function withCurrentId(gameServerId, moduleId, bounty) {
  const current = await getBounty(gameServerId, moduleId, bounty.playerId);
  return { ...bounty, id: current ? current.id : undefined };
}

export function isExpired(entry, expiryDays, now) {
  if (!expiryDays || expiryDays <= 0) return false;
  const placed = new Date(entry.placedAt).getTime();
  if (Number.isNaN(placed)) return false;
  return now.getTime() - placed >= expiryDays * DAY_MS;
}

export function potOf(entries) {
  return entries.reduce((sum, e) => sum + e.amount, 0);
}

export function feeOf(amount, percent) {
  if (!percent || percent <= 0) return 0;
  return Math.ceil((amount * percent) / 100);
}

export async function getPlayerName(playerId, fallback) {
  try {
    const res = await takaro.player.playerControllerGetOne(playerId);
    return res.data.data.name || fallback;
  } catch (err) {
    console.error(`bounties: could not look up player ${playerId}: ${err}`);
    return fallback;
  }
}

export async function broadcast(gameServerId, message) {
  try {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message, opts: {} });
  } catch (err) {
    console.error(`bounties: broadcast failed: ${err}`);
  }
}

/** Private message to a player who may not be the one running this code. Best effort. */
export async function pmPlayer(gameServerId, playerId, message) {
  try {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], playerId: [playerId] },
    });
    const pog = res.data.data[0];
    if (!pog || !pog.gameId) return;
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message,
      opts: { recipient: { gameId: pog.gameId } },
    });
  } catch (err) {
    console.error(`bounties: pm to ${playerId} failed: ${err}`);
  }
}

export async function refund(gameServerId, entry, amount, message) {
  if (amount > 0) {
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, entry.placerId, {
      currency: amount,
    });
  }
  if (message) await pmPlayer(gameServerId, entry.placerId, message);
}

/** Every identifier an admin might type into an exclusion group, lower-cased. */
function identifiersOf(player) {
  return [player.id, player.name, player.gameId, player.steamId, player.epicOnlineServicesId, player.xboxLiveId, player.platformId]
    .filter((v) => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim().toLowerCase());
}

export function inSameExclusionGroup(groups, a, b) {
  if (!Array.isArray(groups) || groups.length === 0) return false;
  const idsA = identifiersOf(a);
  const idsB = identifiersOf(b);
  return groups.some((group) => {
    const members = String(group)
      .split(',')
      .map((m) => m.trim().toLowerCase())
      .filter(Boolean);
    return idsA.some((id) => members.includes(id)) && idsB.some((id) => members.includes(id));
  });
}

async function getPlayerRecord(playerId, fallback) {
  try {
    return (await takaro.player.playerControllerGetOne(playerId)).data.data;
  } catch (err) {
    console.error(`bounties: could not load player ${playerId}: ${err}`);
    return fallback;
  }
}

/**
 * Pays the bounty on `victimPlayerId` to `killerPlayerId`.
 * Expired stakes are refunded instead, and the killer's own stakes stay on the board.
 */
export async function claimBounty({ gameServerId, mod, victimPlayerId, killerPlayerId, killerGameId }) {
  if (!victimPlayerId || !killerPlayerId || victimPlayerId === killerPlayerId) return;
  const config = mod.userConfig || {};
  const moduleId = mod.moduleId;

  const bounty = await getBounty(gameServerId, moduleId, victimPlayerId);
  if (!bounty || bounty.entries.length === 0) {
    console.log(`bounties: no bounty on ${victimPlayerId}`);
    return;
  }

  const [victim, killer] = await Promise.all([
    getPlayerRecord(victimPlayerId, { id: victimPlayerId, name: bounty.targetName }),
    getPlayerRecord(killerPlayerId, { id: killerPlayerId, name: 'Unknown' }),
  ]);
  const killerIds = { ...killer, gameId: killerGameId };
  const { currency } = await getSettings(gameServerId);

  if (inSameExclusionGroup(config.exclusionGroups, killerIds, victim)) {
    console.log(`bounties: ${killer.name} and ${victim.name} share an exclusion group, no claim`);
    await pmPlayer(gameServerId, killerPlayerId, `You and ${victim.name} are in the same group, so you cannot claim their bounty.`);
    return;
  }

  const now = new Date();
  const expired = [];
  const own = [];
  const payable = [];
  for (const entry of bounty.entries) {
    if (isExpired(entry, config.expiryDays, now)) expired.push(entry);
    else if (entry.placerId === killerPlayerId) own.push(entry);
    else payable.push(entry);
  }

  // Persist first so a retry or a second kill source cannot pay the same stakes twice.
  bounty.entries = own;
  await saveBounty(gameServerId, moduleId, bounty);

  for (const entry of expired) {
    try {
      await refund(gameServerId, entry, entry.amount, `Your bounty on ${victim.name} expired. ${entry.amount} ${currency} refunded.`);
    } catch (err) {
      console.error(`bounties: refund of expired stake to ${entry.placerId} failed: ${err}`);
    }
  }

  if (payable.length === 0) {
    if (own.length > 0) {
      await pmPlayer(gameServerId, killerPlayerId, `You cannot claim your own bounty on ${victim.name}. It stays active for others.`);
    }
    return;
  }

  const pot = potOf(payable);
  try {
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, killerPlayerId, { currency: pot });
  } catch (err) {
    // Put the stakes back so the bounty is not lost.
    bounty.entries = [...own, ...payable];
    await saveBounty(gameServerId, moduleId, await withCurrentId(gameServerId, moduleId, bounty));
    throw err;
  }
  console.log(`bounties: ${killer.name} claimed ${pot} on ${victim.name} (${payable.length} stakes)`);
  await broadcast(gameServerId, `${killer.name} collected the ${pot} ${currency} bounty on ${victim.name}!`);
}
