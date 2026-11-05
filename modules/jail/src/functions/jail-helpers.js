import { takaro, data, TakaroUserError } from '@takaro/helpers';

export const JAIL_KEY = 'jail_location';
export const RELEASE_KEY = 'jail_release_point';
export const RECORD_KEY = 'jail_record';

export async function getPrefix() {
  const res = await takaro.settings.settingsControllerGetOne('commandPrefix', data.gameServerId);
  return res.data.data.value;
}

async function findVariable(key, playerId) {
  const filters = {
    key: [key],
    gameServerId: [data.gameServerId],
    moduleId: [data.module.moduleId],
  };
  if (playerId) {
    filters.playerId = [playerId];
  }
  const res = await takaro.variable.variableControllerSearch({ filters });
  return res.data.data[0] ?? null;
}

async function writeVariable(key, playerId, value) {
  const existing = await findVariable(key, playerId);
  const serialized = JSON.stringify(value);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
    return;
  }
  const row = {
    key,
    value: serialized,
    gameServerId: data.gameServerId,
    moduleId: data.module.moduleId,
  };
  if (playerId) {
    row.playerId = playerId;
  }
  await takaro.variable.variableControllerCreate(row);
}

export async function getPoint(key) {
  const row = await findVariable(key);
  return row ? JSON.parse(row.value) : null;
}

export async function setPoint(key, point) {
  await writeVariable(key, null, point);
}

export async function getRecord(playerId) {
  const row = await findVariable(RECORD_KEY, playerId);
  return row ? { ...JSON.parse(row.value), id: row.id, playerId } : null;
}

export async function saveRecord(playerId, record) {
  const { id: _id, playerId: _playerId, ...value } = record;
  await writeVariable(RECORD_KEY, playerId, value);
}

export async function deleteRecord(record) {
  await takaro.variable.variableControllerDelete(record.id);
}

/** Every jail record on this game server (jailed and pending release). */
export async function listRecords() {
  const records = [];
  let page = 0;
  // Paginate so large servers are not cut off at the default page size.
  for (;;) {
    const res = await takaro.variable.variableControllerSearch({
      filters: {
        key: [RECORD_KEY],
        gameServerId: [data.gameServerId],
        moduleId: [data.module.moduleId],
      },
      page,
      limit: 100,
    });
    for (const row of res.data.data) {
      records.push({ ...JSON.parse(row.value), id: row.id, playerId: row.playerId });
    }
    if (res.data.data.length < 100) {
      return records;
    }
    page += 1;
  }
}

export function positionOf(pog) {
  if (!pog || typeof pog.positionX !== 'number' || typeof pog.positionZ !== 'number') {
    return null;
  }
  return {
    x: pog.positionX,
    y: typeof pog.positionY === 'number' ? pog.positionY : 0,
    z: pog.positionZ,
    dimension: pog.dimension ?? null,
  };
}

/** Horizontal (x/z) distance; Infinity when the player is in another dimension. */
export function distance(a, b) {
  if (a.dimension && b.dimension && a.dimension !== b.dimension) {
    return Infinity;
  }
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function isExpired(record, now = new Date()) {
  return record.until !== null && new Date(record.until).getTime() <= now.getTime();
}

export function formatRemaining(record, now = new Date()) {
  if (record.until === null) {
    return 'until a staff member releases you';
  }
  const ms = Math.max(0, new Date(record.until).getTime() - now.getTime());
  const totalMinutes = Math.ceil(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

export async function teleport(playerId, point) {
  const body = { x: point.x, y: point.y, z: point.z };
  if (point.dimension) {
    body.dimension = point.dimension;
  }
  await takaro.gameserver.gameServerControllerTeleportPlayer(data.gameServerId, playerId, body);
}

/** Teleport, but turn a connector failure into `false` instead of a crash. */
export async function tryTeleport(playerId, point) {
  try {
    await teleport(playerId, point);
    return true;
  } catch (err) {
    console.log(`Teleport of ${playerId} failed: ${err?.message ?? err}`);
    return false;
  }
}

export async function pmPlayer(gameId, message) {
  await takaro.gameserver.gameServerControllerSendMessage(data.gameServerId, {
    message,
    opts: { recipient: { gameId } },
  });
}

export async function broadcast(message) {
  if (!data.module.userConfig.announce) {
    return;
  }
  await takaro.gameserver.gameServerControllerSendMessage(data.gameServerId, { message });
}

export async function assignJailedRole(playerId) {
  const roleId = data.module.userConfig.jailedRoleId;
  if (!roleId) {
    return false;
  }
  try {
    await takaro.player.playerControllerAssignRole(playerId, roleId, { gameServerId: data.gameServerId });
    return true;
  } catch (err) {
    console.log(`Could not assign jailed role ${roleId}: ${err?.message ?? err}`);
    return false;
  }
}

export async function removeJailedRole(playerId, record) {
  const roleId = record.roleId;
  if (!roleId) {
    return;
  }
  try {
    await takaro.player.playerControllerRemoveRole(playerId, roleId, { gameServerId: data.gameServerId });
  } catch (err) {
    console.log(`Could not remove jailed role ${roleId}: ${err?.message ?? err}`);
  }
}

/** Where a released player should go, honouring config with fallbacks. Null = leave them. */
export async function releaseTarget(record) {
  const mode = data.module.userConfig.releaseTo;
  if (mode === 'stay') {
    return null;
  }
  const releasePoint = await getPoint(RELEASE_KEY);
  if (mode === 'releasePoint') {
    return releasePoint ?? record.returnTo ?? null;
  }
  return record.returnTo ?? releasePoint ?? null;
}

export async function findPog(playerId) {
  const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: { gameServerId: [data.gameServerId], playerId: [playerId] },
  });
  return res.data.data[0] ?? null;
}

/**
 * Release a jailed player. When online they are teleported to the release target and the record is deleted.
 * When offline (or the teleport fails) the record is kept as `pendingRelease` and finished on the next connect
 * or cron run. Returns 'released' | 'pending'.
 */
export async function releasePlayer(record, { online, gameId, reasonText }) {
  if (record.status !== 'pendingRelease') {
    await removeJailedRole(record.playerId, record);
  }
  const target = await releaseTarget(record);

  if (!target) {
    await deleteRecord(record);
    if (online && gameId) {
      await pmPlayer(gameId, `You are free. ${reasonText}`);
    }
    return 'released';
  }

  if (online && (await tryTeleport(record.playerId, target))) {
    await deleteRecord(record);
    if (gameId) {
      await pmPlayer(gameId, `You are free. ${reasonText}`);
    }
    return 'released';
  }

  await saveRecord(record.playerId, { ...record, status: 'pendingRelease', roleId: null });
  return 'pending';
}

export function requireManage(checkPermission) {
  if (!checkPermission(data.pog, 'JAIL_MANAGE')) {
    throw new TakaroUserError('You do not have permission to manage the jail.');
  }
}

export async function playerName(playerId) {
  try {
    const res = await takaro.player.playerControllerGetOne(playerId);
    return res.data.data.name;
  } catch {
    return 'Unknown player';
  }
}
