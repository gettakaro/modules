import { takaro, checkPermission } from '@takaro/helpers';

export const JOINED_AT_KEY = 'reserved-slots:joinedAt';
export const PERM_RESERVED = 'RESERVED_SLOT';
export const PERM_EXEMPT = 'RESERVED_SLOT_EXEMPT';

/** Public and reserved slot numbers from the user config; `enabled` is false until maxPlayers is set. */
export function getSlotConfig(userConfig) {
  const maxPlayers = Math.max(0, Math.floor(Number(userConfig.maxPlayers) || 0));
  const reservedSlots = Math.min(maxPlayers, Math.max(0, Math.floor(Number(userConfig.reservedSlots) || 0)));
  return {
    enabled: maxPlayers > 0,
    maxPlayers,
    reservedSlots,
    publicSlots: maxPlayers - reservedSlots,
  };
}

/** All online players on this server, fetched page by page (sequential, to stay under the request limit). */
export async function getOnlinePlayers(gameServerId) {
  const limit = 100;
  let all = [];
  for (let page = 0; page < 50; page++) {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], online: [true] },
      page,
      limit,
    });
    all = all.concat(res.data.data);
    if (res.data.data.length < limit || all.length >= res.data.meta.total) break;
  }
  return all;
}

export function hasReservedSlot(pog) {
  return !!checkPermission(pog, PERM_RESERVED);
}

export function isExempt(pog) {
  return !!checkPermission(pog, PERM_EXEMPT);
}

/** A regular player: no reserved slot and not exempt, so the module may kick them. */
export function isKickable(pog) {
  return !hasReservedSlot(pog) && !isExempt(pog);
}

/** Store when a player joined this server, so the "newest" strategy can find the last joiner. */
export async function recordJoin(gameServerId, moduleId, playerId, timestamp) {
  const existing = await takaro.variable.variableControllerSearch({
    filters: { key: [JOINED_AT_KEY], gameServerId: [gameServerId], moduleId: [moduleId], playerId: [playerId] },
  });
  const value = String(timestamp);
  if (existing.data.data.length > 0) {
    await takaro.variable.variableControllerUpdate(existing.data.data[0].id, { value });
  } else {
    await takaro.variable.variableControllerCreate({ key: JOINED_AT_KEY, value, gameServerId, moduleId, playerId });
  }
}

/** Map of playerId -> join timestamp (ms) for this server. */
export async function getJoinTimes(gameServerId, moduleId) {
  const map = {};
  const limit = 100;
  for (let page = 0; page < 50; page++) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { key: [JOINED_AT_KEY], gameServerId: [gameServerId], moduleId: [moduleId] },
      page,
      limit,
    });
    for (const row of res.data.data) {
      const ts = Number(row.value);
      if (row.playerId && Number.isFinite(ts)) map[row.playerId] = ts;
    }
    if (res.data.data.length < limit) break;
  }
  return map;
}

/**
 * Pick which regular player to kick.
 * - newest: latest recorded join (players with no record count as joined long ago)
 * - lowestPlaytime: least playtimeSeconds on this server
 * - random: any candidate
 */
export async function pickVictim(candidates, strategy, gameServerId, moduleId) {
  if (candidates.length === 0) return null;
  if (strategy === 'random') {
    return candidates[Math.floor(Math.random() * candidates.length)] ?? candidates[0];
  }
  if (strategy === 'lowestPlaytime') {
    return candidates.reduce((best, pog) =>
      (Number(pog.playtimeSeconds) || 0) < (Number(best.playtimeSeconds) || 0) ? pog : best,
    );
  }
  const joined = await getJoinTimes(gameServerId, moduleId);
  return candidates.reduce((best, pog) => ((joined[pog.playerId] ?? 0) > (joined[best.playerId] ?? 0) ? pog : best));
}

/** Fill {link}, {reserved} and {max} in a message template. */
export function fillMessage(template, userConfig, slots) {
  return String(template ?? '')
    .replaceAll('{link}', userConfig.vipLink ?? '')
    .replaceAll('{reserved}', String(slots.reservedSlots))
    .replaceAll('{max}', String(slots.maxPlayers));
}

/** Kick a player; returns false (and logs) when the game/connector cannot kick, instead of failing the hook. */
export async function safeKick(gameServerId, playerId, reason) {
  try {
    await takaro.gameserver.gameServerControllerKickPlayer(gameServerId, playerId, { reason });
    return true;
  } catch (err) {
    const detail = err?.response?.data?.meta?.error?.message ?? err?.message ?? String(err);
    console.error(`reserved-slots: kick failed for player ${playerId} (game may not support kick): ${detail}`);
    return false;
  }
}
