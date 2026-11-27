import { takaro, data, checkPermission, TakaroUserError } from '@takaro/helpers';

export const STATE_KEY = 'crime_state';
export const IMMUNE_PERMISSION = 'ROB_IMMUNE';

// Jail module state we read and write (same keys as the registry `jail` module).
const JAIL_LOCATION_KEY = 'jail_location';
const JAIL_RECORD_KEY = 'jail_record';

export async function getSetting(key) {
  const res = await takaro.settings.settingsControllerGetOne(key, data.gameServerId);
  return res.data.data.value;
}

/** Prefix + currency name, and a clear error when the economy is off. */
export async function loadContext() {
  const [prefix, currencyName, economyEnabled] = await Promise.all([
    getSetting('commandPrefix'),
    getSetting('currencyName'),
    getSetting('economyEnabled'),
  ]);
  if (String(economyEnabled) !== 'true') {
    throw new TakaroUserError('The economy is turned off on this server, so crime does not pay here.');
  }
  return { prefix, currencyName };
}

export function formatAmount(n) {
  return Math.floor(Number(n) || 0).toLocaleString('en-US');
}

export function money(n, currencyName) {
  return `${formatAmount(n)} ${currencyName}`;
}

/** 90 min -> "1h 30m", 0.2 min -> "1m". */
export function formatDuration(ms) {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  return parts.join(' ');
}

/** Whole number in [min, max], both inclusive. Swaps a reversed range. */
export function randomInt(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** True with `percent` % chance. */
export function chance(percent) {
  return Math.random() * 100 < percent;
}

export function pick(list, fallback) {
  const items = (Array.isArray(list) ? list : []).filter((s) => typeof s === 'string' && s.trim());
  if (!items.length) return fallback;
  return items[Math.floor(Math.random() * items.length)];
}

/** Fill {amount}, {player}, {victim} placeholders and keep it to one chat line. */
export function fill(template, values) {
  let out = String(template);
  for (const [k, v] of Object.entries(values)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out.replace(/[\r\n]+/g, ' ').trim();
}

// ---- per-player state ----------------------------------------------------------------------

export function emptyState(name) {
  return {
    name,
    crimeReadyAt: null,
    robReadyAt: null,
    protectedUntil: null,
    crimes: 0,
    crimesWon: 0,
    crimeEarned: 0,
    crimeFines: 0,
    robs: 0,
    robsWon: 0,
    stolen: 0,
    robFines: 0,
    timesRobbed: 0,
    lostToRobbers: 0,
    finesReceived: 0,
  };
}

async function findStateRow(playerId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: {
      key: [STATE_KEY],
      gameServerId: [data.gameServerId],
      moduleId: [data.module.moduleId],
      playerId: [playerId],
    },
  });
  return res.data.data[0] ?? null;
}

export async function loadState(playerId, name) {
  const row = await findStateRow(playerId);
  const state = { ...emptyState(name), ...(row ? JSON.parse(row.value) : {}) };
  if (name) state.name = name;
  return { state, rowId: row ? row.id : null };
}

export async function saveState(playerId, entry) {
  const value = JSON.stringify(entry.state);
  if (entry.rowId) {
    await takaro.variable.variableControllerUpdate(entry.rowId, { value });
    return;
  }
  const res = await takaro.variable.variableControllerCreate({
    key: STATE_KEY,
    value,
    gameServerId: data.gameServerId,
    moduleId: data.module.moduleId,
    playerId,
  });
  entry.rowId = res.data.data.id;
}

export function msLeft(iso, now) {
  if (!iso) return 0;
  return Math.max(0, new Date(iso).getTime() - now);
}

// ---- players + currency --------------------------------------------------------------------

export async function freshPog(playerId) {
  return (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(data.gameServerId, playerId)).data.data;
}

export async function playerName(playerId, fallback = 'Unknown player') {
  try {
    return (await takaro.player.playerControllerGetOne(playerId)).data.data.name;
  } catch {
    return fallback;
  }
}

export function isImmune(pog) {
  return Boolean(checkPermission(pog, IMMUNE_PERMISSION));
}

export async function addCurrency(playerId, amount) {
  if (amount <= 0) return;
  await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(data.gameServerId, playerId, { currency: amount });
}

export async function deductCurrency(playerId, amount) {
  if (amount <= 0) return;
  await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(data.gameServerId, playerId, { currency: amount });
}

export async function pmTo(gameId, message) {
  if (!gameId) return;
  await takaro.gameserver.gameServerControllerSendMessage(data.gameServerId, {
    message,
    opts: { recipient: { gameId } },
  });
}

export async function broadcast(message) {
  await takaro.gameserver.gameServerControllerSendMessage(data.gameServerId, { message });
}

// ---- optional jail integration -------------------------------------------------------------

/**
 * The registry `jail` module installed on this game server, or null. Registry installs can be
 * renamed `jail-<registryId>`, so match the name and check it has the jail-enforcer cron job.
 */
export async function findJailInstallation() {
  try {
    const res = await takaro.module.moduleInstallationsControllerGetInstalledModules({
      filters: { gameserverId: [data.gameServerId] },
      limit: 100,
    });
    for (const inst of res.data.data) {
      const name = String(inst.module?.name ?? '');
      if (name !== 'jail' && !/^jail-[0-9a-f]{8}$/.test(name)) continue;
      const crons = inst.version?.cronJobs ?? [];
      if (crons.length && !crons.some((c) => c.name === 'jail-enforcer')) continue;
      return inst;
    }
  } catch (err) {
    console.log(`rob-and-crime: could not list installed modules: ${err?.message ?? err}`);
  }
  return null;
}

async function jailVariable(jail, key, playerId) {
  const filters = { key: [key], gameServerId: [data.gameServerId], moduleId: [jail.moduleId] };
  if (playerId) filters.playerId = [playerId];
  const res = await takaro.variable.variableControllerSearch({ filters });
  return res.data.data[0] ?? null;
}

/** True when the jail module has this player in jail right now. */
export async function isJailed(jail, playerId) {
  if (!jail) return false;
  const row = await jailVariable(jail, JAIL_RECORD_KEY, playerId);
  if (!row) return false;
  const record = JSON.parse(row.value);
  return record.status === 'jailed' && (record.until === null || new Date(record.until).getTime() > Date.now());
}

/**
 * Put a player in the jail module's jail for `minutes`. Writes the same record the jail module
 * writes; its every-minute cron job then teleports them in, keeps them inside and releases them.
 * We never teleport here, so this module needs no teleport capability and runs on every game.
 * Never throws. Returns 'jailed' | 'no-jail-module' | 'no-jail-spot' | 'already-jailed' | 'error'.
 */
export async function sendToJail(jail, pog, name, minutes, reason) {
  if (!jail) return 'no-jail-module';
  try {
    const locRow = await jailVariable(jail, JAIL_LOCATION_KEY);
    if (!locRow) return 'no-jail-spot';
    const existingRow = await jailVariable(jail, JAIL_RECORD_KEY, pog.playerId);
    const existing = existingRow ? JSON.parse(existingRow.value) : null;
    if (existing && existing.status === 'jailed') return 'already-jailed';

    const now = new Date();
    const hasPos = typeof pog.positionX === 'number' && typeof pog.positionZ === 'number';
    const record = {
      status: 'jailed',
      name,
      reason,
      by: 'rob-and-crime',
      startedAt: now.toISOString(),
      until: new Date(now.getTime() + minutes * 60000).toISOString(),
      returnTo:
        existing?.returnTo ??
        (hasPos
          ? {
              x: pog.positionX,
              y: typeof pog.positionY === 'number' ? pog.positionY : 0,
              z: pog.positionZ,
              dimension: pog.dimension ?? null,
            }
          : null),
      roleId: null,
    };
    const roleId = jail.userConfig?.jailedRoleId;
    if (roleId) {
      try {
        await takaro.player.playerControllerAssignRole(pog.playerId, roleId, { gameServerId: data.gameServerId });
        record.roleId = roleId;
      } catch (err) {
        console.log(`rob-and-crime: could not assign jailed role: ${err?.message ?? err}`);
      }
    }
    const value = JSON.stringify(record);
    if (existingRow) {
      await takaro.variable.variableControllerUpdate(existingRow.id, { value });
    } else {
      await takaro.variable.variableControllerCreate({
        key: JAIL_RECORD_KEY,
        value,
        gameServerId: data.gameServerId,
        moduleId: jail.moduleId,
        playerId: pog.playerId,
      });
    }
    return 'jailed';
  } catch (err) {
    console.log(`rob-and-crime: jailing failed: ${err?.message ?? err}`);
    return 'error';
  }
}
