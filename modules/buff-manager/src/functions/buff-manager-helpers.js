import { takaro } from '@takaro/helpers';

export const WORLD_EVENT_KEY = 'buff_world_event_active';

export function get7dtdCommandTarget(pogOrOnlinePlayer, fallbackPlayer) {
  const gameId = pogOrOnlinePlayer?.gameId;
  if (gameId) return String(gameId).startsWith('EOS_') ? String(gameId) : `EOS_${gameId}`;
  return JSON.stringify(fallbackPlayer?.name || pogOrOnlinePlayer?.name || '');
}

export function findBuffPackage(buffPackages, packageName) {
  const normalized = String(packageName || '').trim().toLowerCase();
  return (buffPackages || []).find((pkg) => String(pkg.commandName || '').toLowerCase() === normalized);
}

export function resolveWorldEventPackage(buffPackages, packageName) {
  const packages = buffPackages || [];
  const normalized = String(packageName || '').trim().toLowerCase();
  if (normalized === 'random') {
    if (packages.length === 0) return null;
    return packages[Math.floor(Math.random() * packages.length)];
  }
  return findBuffPackage(packages, packageName);
}

export function formatDuration(minutes) {
  const value = Math.floor(Number(minutes));
  if (!Number.isFinite(value) || value <= 0) return 'permanent';
  const hours = Math.floor(value / 60);
  return hours > 0 ? `${hours}h ${value % 60}m` : `${value}m`;
}

export function isWorldEventExpired(eventState) {
  return Number(eventState?.expiresAt || 0) > 0 && Date.now() > Number(eventState.expiresAt);
}

export async function findVariable(gameServerId, moduleId, key) {
  const res = await takaro.variable.variableControllerSearch({
    filters: {
      key: [key],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
    },
    limit: 1,
  });
  return res.data.data.length > 0 ? res.data.data[0] : null;
}

export async function readWorldEvent(gameServerId, moduleId) {
  const variable = await findVariable(gameServerId, moduleId, WORLD_EVENT_KEY);
  if (!variable) return { variable: null, state: null };

  try {
    return { variable, state: JSON.parse(variable.value) };
  } catch (err) {
    console.log(`⚠️ Failed to parse world event state. Clearing invalid state: ${err.message}`);
    await takaro.variable.variableControllerDelete(variable.id);
    return { variable: null, state: null };
  }
}

export async function writeWorldEvent(gameServerId, moduleId, state) {
  const existing = await findVariable(gameServerId, moduleId, WORLD_EVENT_KEY);
  const value = JSON.stringify(state);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value });
  } else {
    await takaro.variable.variableControllerCreate({
      key: WORLD_EVENT_KEY,
      value,
      gameServerId,
      moduleId,
    });
  }
}

export async function clearWorldEvent(gameServerId, moduleId) {
  const existing = await findVariable(gameServerId, moduleId, WORLD_EVENT_KEY);
  if (existing) await takaro.variable.variableControllerDelete(existing.id);
}

export async function getOnlinePogs(gameServerId) {
  const pogsRes = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: {
      gameServerId: [gameServerId],
      online: [true],
    },
    extend: ['player'],
    limit: 100,
  });
  return pogsRes.data.data || [];
}

export async function applyPackageToPog(gameServerId, pkg, pog) {
  const player = pog.player || { name: pog.name || pog.gameId };
  const commandTarget = get7dtdCommandTarget(pog, player);
  const buffNames = pkg.buffNames || [];
  const results = await Promise.all(buffNames.map((buffName) =>
    takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, {
      command: `buffplayer ${commandTarget} ${buffName}`,
    })
      .then(() => ({ success: true, buffName }))
      .catch((err) => {
        console.log(`      ✗ Failed to apply ${buffName} to ${player.name || pog.gameId}: ${err.message}`);
        return { success: false, buffName };
      })
  ));
  return results.filter((result) => result.success).length;
}

export async function removePackageFromPog(gameServerId, pkg, pog) {
  const player = pog.player || { name: pog.name || pog.gameId };
  const commandTarget = get7dtdCommandTarget(pog, player);
  const buffNames = pkg.buffNames || [];
  const results = await Promise.all(buffNames.map((buffName) =>
    takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, {
      command: `debuffplayer ${commandTarget} ${buffName}`,
    })
      .then(() => ({ success: true, buffName }))
      .catch((err) => {
        console.log(`      ✗ Failed to remove ${buffName} from ${player.name || pog.gameId}: ${err.message}`);
        return { success: false, buffName };
      })
  ));
  return results.filter((result) => result.success).length;
}
