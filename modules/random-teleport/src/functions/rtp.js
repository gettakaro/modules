import { takaro, data, checkPermission, TakaroUserError } from '@takaro/helpers';

export const USE_PERMISSION = 'RTP_USE';
export const BYPASS_COOLDOWN_PERMISSION = 'RTP_BYPASS_COOLDOWN';

const COOLDOWN_KEY = 'rtp_cooldown';

function scope() {
  return { gameServerId: data.gameServerId, moduleId: data.module.moduleId };
}

export function requireUse() {
  if (!checkPermission(data.pog, USE_PERMISSION)) {
    throw new TakaroUserError('You do not have permission to use random teleport.');
  }
}

export function formatDuration(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds <= 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export async function currencyName() {
  try {
    const res = await takaro.settings.settingsControllerGetOne('currencyName', data.gameServerId);
    return res.data.data.value || 'currency';
  } catch {
    return 'currency';
  }
}

export async function freshPog(playerId) {
  return (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(data.gameServerId, playerId)).data.data;
}

const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** The configured area with defaults filled in. Throws a player-facing error when it cannot hold any point. */
export function readArea(config) {
  if ((config.areaShape ?? 'circle') === 'rectangle') {
    const area = {
      shape: 'rectangle',
      minX: num(config.minX, -2000),
      maxX: num(config.maxX, 2000),
      minZ: num(config.minZ, -2000),
      maxZ: num(config.maxZ, 2000),
    };
    if (area.minX > area.maxX || area.minZ > area.maxZ) {
      throw new TakaroUserError('Random teleport is not set up correctly (min is above max). Please tell an admin.');
    }
    return area;
  }
  const area = {
    shape: 'circle',
    x: num(config.centerX, 0),
    z: num(config.centerZ, 0),
    minRadius: Math.max(0, num(config.minRadius, 500)),
    maxRadius: num(config.maxRadius, 2000),
  };
  if (area.maxRadius <= 0 || area.minRadius > area.maxRadius) {
    throw new TakaroUserError(
      'Random teleport is not set up correctly (minimum radius is above maximum radius). Please tell an admin.',
    );
  }
  return area;
}

/** One random point in `area`, uniform by surface. `random` returns values in [0, 1). */
export function randomPoint(area, random) {
  if (area.shape === 'rectangle') {
    return {
      x: Math.round(area.minX + random() * (area.maxX - area.minX)),
      z: Math.round(area.minZ + random() * (area.maxZ - area.minZ)),
    };
  }
  const inner = area.minRadius * area.minRadius;
  const outer = area.maxRadius * area.maxRadius;
  // sqrt keeps the density even across the ring instead of crowding the centre.
  const r = Math.sqrt(inner + random() * (outer - inner));
  const angle = random() * 2 * Math.PI;
  return {
    x: Math.round(area.x + r * Math.cos(angle)),
    z: Math.round(area.z + r * Math.sin(angle)),
  };
}

/** True when the point lies in the blocked zone. Zones with missing numbers block nothing. */
export function inZone(point, zone) {
  if (!zone || typeof zone !== 'object') {
    return false;
  }
  if (zone.shape === 'rectangle') {
    const { minX, maxX, minZ, maxZ } = zone;
    if (![minX, maxX, minZ, maxZ].every((v) => typeof v === 'number')) {
      return false;
    }
    return point.x >= minX && point.x <= maxX && point.z >= minZ && point.z <= maxZ;
  }
  const { x, z, radius } = zone;
  if (![x, z, radius].every((v) => typeof v === 'number')) {
    return false;
  }
  const dx = point.x - x;
  const dz = point.z - z;
  return dx * dx + dz * dz <= radius * radius;
}

/** A random point outside every blocked zone, or null after `maxAttempts` misses. */
export function findSpot(config, random) {
  const area = readArea(config);
  const zones = Array.isArray(config.blockedZones) ? config.blockedZones : [];
  const attempts = Math.max(1, Math.floor(num(config.maxAttempts, 30)));
  for (let i = 0; i < attempts; i++) {
    const point = randomPoint(area, random);
    const blocked = zones.find((zone) => inZone(point, zone));
    if (!blocked) {
      return point;
    }
    console.log(`Attempt ${i + 1}: ${point.x},${point.z} is inside blocked zone ${blocked.name ?? '(unnamed)'}`);
  }
  return null;
}

async function cooldownRow(playerId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: {
      key: [COOLDOWN_KEY],
      playerId: [playerId],
      gameServerId: [data.gameServerId],
      moduleId: [data.module.moduleId],
    },
  });
  return res.data.data[0];
}

/** Milliseconds left on `playerId`'s cooldown, 0 when none. */
export async function cooldownLeft(playerId) {
  const row = await cooldownRow(playerId);
  if (!row?.expiresAt) {
    return 0;
  }
  return Math.max(0, new Date(row.expiresAt).getTime() - Date.now());
}

export async function startCooldown(playerId, ms) {
  if (!(ms > 0)) {
    return;
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ms).toISOString();
  const value = JSON.stringify({ usedAt: now.toISOString() });
  const existing = await cooldownRow(playerId);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value, expiresAt });
    return;
  }
  await takaro.variable.variableControllerCreate({ key: COOLDOWN_KEY, value, playerId, expiresAt, ...scope() });
}

/** Teleports the player; on failure throws a player-facing error that says nothing was charged. */
export async function teleport(playerId, destination) {
  try {
    await takaro.gameserver.gameServerControllerTeleportPlayer(data.gameServerId, playerId, destination);
  } catch (error) {
    console.log(`Teleport failed: ${error?.message ?? error}`);
    const body = error?.response?.data;
    const reason = body?.meta?.error?.message ?? body?.error?.message;
    throw new TakaroUserError(
      reason
        ? `Random teleport failed: ${reason}. You were not charged.`
        : 'Random teleport failed. This server may not support teleporting players. You were not charged.',
    );
  }
}
