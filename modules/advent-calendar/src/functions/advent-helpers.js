import { takaro } from '@takaro/helpers';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const CATCH_UP_PERMISSION = 'ADVENT_CALENDAR_CATCH_UP';
export const MANAGE_PERMISSION = 'ADVENT_CALENDAR_MANAGE';
const PROGRESS_PREFIX = 'advent_progress_';
const DOOR_PREFIX = 'advent_door_';
const PENDING_ITEMS_KEY = 'advent_pending_items';
export const ANNOUNCED_KEY = 'advent_announced';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- calendar ----------

/** Parses 'MM-DD' (every year) or 'YYYY-MM-DD' (one year only). Returns null when invalid. */
export function parseStartDate(value) {
  const match = /^\s*(?:(\d{4})-)?(\d{1,2})-(\d{1,2})\s*$/.exec(String(value ?? ''));
  if (!match) return null;
  const year = match[1] ? Number(match[1]) : null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

export function offsetMs(config) {
  const hours = Number(config.utcOffsetHours);
  if (!Number.isFinite(hours) || hours < -12 || hours > 14) return 0;
  return Math.round(hours * 60) * 60 * 1000;
}

export function totalDays(config) {
  const n = Math.floor(Number(config.numberOfDays));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 366) : 24;
}

/** Local midnight as a UTC-based day stamp (ms). */
function dayStamp(year, month, day) {
  return Date.UTC(year, month - 1, day);
}

/**
 * Where we are in the calendar right now.
 * status: 'before' | 'running' | 'after' | 'invalid'
 * Times ending in Ms are real instants; *Stamp values are local dates at 00:00 encoded as UTC.
 */
export function resolveEvent(config, nowMs) {
  const start = parseStartDate(config.startDate);
  const days = totalDays(config);
  const offset = offsetMs(config);
  if (!start) return { status: 'invalid', totalDays: days };

  const local = new Date(nowMs + offset);
  const todayStamp = dayStamp(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate());

  let startStamp;
  if (start.year !== null) {
    startStamp = dayStamp(start.year, start.month, start.day);
  } else {
    const year = local.getUTCFullYear();
    const previous = dayStamp(year - 1, start.month, start.day);
    // An event that crosses New Year (e.g. Dec 25 + 14 days) may still be running from last year.
    startStamp = todayStamp < previous + days * DAY_MS ? previous : dayStamp(year, start.month, start.day);
  }
  const endStamp = startStamp + days * DAY_MS; // exclusive
  const base = {
    totalDays: days,
    startStamp,
    endStamp,
    eventKey: new Date(startStamp).toISOString().slice(0, 10),
    startsAtMs: startStamp - offset,
    endsAtMs: endStamp - offset,
  };
  if (todayStamp < startStamp) return { ...base, status: 'before' };
  if (todayStamp >= endStamp) return { ...base, status: 'after' };
  const today = Math.floor((todayStamp - startStamp) / DAY_MS) + 1;
  return { ...base, status: 'running', today, nextDoorMs: todayStamp + DAY_MS - offset };
}

export function doorDate(event, door) {
  const d = new Date(event.startStamp + (door - 1) * DAY_MS);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function offsetLabel(config) {
  const minutes = offsetMs(config) / 60000;
  if (minutes === 0) return 'UTC';
  const sign = minutes > 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

export function formatDuration(ms) {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60000));
  const d = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

// ---------- rewards ----------

function cleanItems(list) {
  return Array.isArray(list) ? list.filter((i) => i && i.item) : [];
}

/** The reward of one door. A row in `doors` replaces the default for that door completely. */
export function rewardForDoor(config, door, days) {
  const custom = (Array.isArray(config.doors) ? config.doors : []).find((d) => d && Number(d.day) === door);
  if (custom) {
    return {
      currency: Math.max(0, Math.floor(Number(custom.currency) || 0)),
      items: cleanItems(custom.items),
      roleId: custom.roleId || '',
      custom: true,
    };
  }
  if (door === days) {
    return {
      currency: Math.max(0, Math.floor(Number(config.lastDayCurrency) || 0)),
      items: cleanItems(config.lastDayItems),
      roleId: config.lastDayRoleId || '',
      custom: false,
    };
  }
  return {
    currency: Math.max(0, Math.floor(Number(config.dailyCurrency) || 0)),
    items: cleanItems(config.dailyItems),
    roleId: '',
    custom: false,
  };
}

async function itemName(id) {
  try {
    return (await takaro.item.itemControllerFindOne(id)).data.data.name || id;
  } catch {
    return id;
  }
}

async function roleName(id) {
  try {
    return (await takaro.role.roleControllerGetOne(id)).data.data.name || 'a special role';
  } catch {
    return 'a special role';
  }
}

/** "50 Takaro coins, 2x Medkit, role Elf" (sequential lookups: the sandbox caps parallel requests). */
export async function describeReward(reward, currencyName) {
  const parts = [];
  if (reward.currency > 0) parts.push(`${reward.currency} ${currencyName}`);
  for (const item of reward.items) parts.push(`${item.amount || 1}x ${await itemName(item.item)}`);
  if (reward.roleId) parts.push(`role ${await roleName(reward.roleId)}`);
  return parts.length > 0 ? parts.join(', ') : 'a surprise (nothing set yet)';
}

async function giveItems(gameServerId, playerId, items) {
  const failed = [];
  for (const item of items) {
    try {
      await takaro.gameserver.gameServerControllerGiveItem(gameServerId, playerId, {
        name: item.item,
        amount: item.amount || 1,
        // The API requires quality; '' means the game's default.
        quality: item.quality ?? '',
      });
    } catch (err) {
      console.error(`advent-calendar: give item ${item.item} to ${playerId} failed: ${err}`);
      failed.push(item);
    }
  }
  return failed;
}

/**
 * Pays one door. Currency first: if that fails nothing was given and the caller undoes the claim.
 * Items that fail are queued for the next join; a failed role is logged.
 */
export async function giveReward({ gameServerId, moduleId, playerId, reward, config, nowMs }) {
  if (reward.currency > 0) {
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, {
      currency: reward.currency,
    });
  }
  const result = { itemsQueued: 0, roleFailed: false };
  if (reward.items.length > 0) {
    const failed = await giveItems(gameServerId, playerId, reward.items);
    if (failed.length > 0) {
      const existing = parseJson(await findVariable(PENDING_ITEMS_KEY, gameServerId, moduleId, playerId), []);
      await saveVariable(PENDING_ITEMS_KEY, gameServerId, moduleId, playerId, existing.concat(failed));
      result.itemsQueued = failed.length;
    }
  }
  if (reward.roleId) {
    try {
      const body = { gameServerId };
      const roleDays = Number(config.roleDays) || 0;
      if (roleDays > 0) body.expiresAt = new Date(nowMs + roleDays * DAY_MS).toISOString();
      await takaro.player.playerControllerAssignRole(playerId, reward.roleId, body);
    } catch (err) {
      console.error(`advent-calendar: assign role ${reward.roleId} to ${playerId} failed: ${err}`);
      result.roleFailed = true;
    }
  }
  return result;
}

/** Gives queued items to a player who just joined. Returns how many were delivered. */
export async function deliverPendingItems(gameServerId, moduleId, playerId) {
  const variable = await findVariable(PENDING_ITEMS_KEY, gameServerId, moduleId, playerId);
  const pending = parseJson(variable, []);
  if (pending.length === 0) return 0;
  const failed = await giveItems(gameServerId, playerId, pending);
  if (failed.length === 0) await takaro.variable.variableControllerDelete(variable.id);
  else await saveVariable(PENDING_ITEMS_KEY, gameServerId, moduleId, playerId, failed);
  return pending.length - failed.length;
}

// ---------- variables ----------

export async function findVariable(key, gameServerId, moduleId, playerId) {
  const filters = { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] };
  if (playerId) filters.playerId = [playerId];
  const res = await takaro.variable.variableControllerSearch({ filters });
  return res.data.data.length > 0 ? res.data.data[0] : null;
}

export function parseJson(variable, fallback) {
  if (!variable) return fallback;
  try {
    return JSON.parse(variable.value);
  } catch {
    return fallback;
  }
}

export async function saveVariable(key, gameServerId, moduleId, playerId, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const existing = await findVariable(key, gameServerId, moduleId, playerId);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: text });
  } else {
    const body = { key, value: text, gameServerId, moduleId };
    if (playerId) body.playerId = playerId;
    await takaro.variable.variableControllerCreate(body);
  }
}

/** This player's progress for one event: { opened: number[], catchUps: number }. */
export async function getProgress(event, gameServerId, moduleId, playerId) {
  const value = parseJson(await findVariable(PROGRESS_PREFIX + event.eventKey, gameServerId, moduleId, playerId), {});
  return {
    opened: Array.isArray(value.opened) ? value.opened.map(Number) : [],
    catchUps: Number(value.catchUps) || 0,
  };
}

export async function saveProgress(event, gameServerId, moduleId, playerId, progress) {
  await saveVariable(PROGRESS_PREFIX + event.eventKey, gameServerId, moduleId, playerId, progress);
}

/**
 * Claims one door atomically: the variable key is unique, so a second create (double command,
 * two servers racing) gets a conflict. Returns the variable id, or null when already claimed.
 */
export async function claimDoor(event, door, gameServerId, moduleId, playerId, nowMs) {
  try {
    const res = await takaro.variable.variableControllerCreate({
      key: `${DOOR_PREFIX}${event.eventKey}_${door}`,
      value: String(nowMs),
      gameServerId,
      moduleId,
      playerId,
    });
    return res.data.data.id;
  } catch (err) {
    const text = String(err && err.message);
    if (text.includes('409') || /exist|conflict|unique/i.test(text)) return null;
    throw err;
  }
}

export async function releaseDoor(claimId) {
  try {
    await takaro.variable.variableControllerDelete(claimId);
  } catch (err) {
    console.error(`advent-calendar: could not release door claim ${claimId}: ${err}`);
  }
}

// ---------- settings / text ----------

export async function getSetting(key, gameServerId, fallback) {
  try {
    const res = await takaro.settings.settingsControllerGetOne(key, gameServerId);
    const value = res.data.data.value;
    return value === undefined || value === null || value === '' ? fallback : value;
  } catch {
    return fallback;
  }
}

export async function getTextContext(gameServerId) {
  const prefix = await getSetting('commandPrefix', gameServerId, '/');
  const currency = await getSetting('currencyName', gameServerId, 'coins');
  return { prefix, currency };
}

export function eventName(config) {
  const name = String(config.eventName ?? '').trim();
  return name || 'Advent calendar';
}

/** Fills {placeholders}. Strips line breaks: 7D2D shows a message as one line. */
export function fill(template, values) {
  return String(template ?? '')
    .replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}

export function listDoors(doors, max = 10) {
  const sorted = [...doors].sort((a, b) => a - b);
  const shown = sorted.slice(0, max).join(', ');
  return sorted.length > max ? `${shown} and ${sorted.length - max} more` : shown;
}
