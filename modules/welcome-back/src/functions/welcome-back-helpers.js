import { takaro } from '@takaro/helpers';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const LAST_KEY = 'welcome_back_last';
export const LOCK_KEY = 'welcome_back_lock';
export const STATS_KEY = 'welcome_back_weekly';
export const MAX_WEEKS = 26;
// A player-on-gameserver row younger than this is a first join: onboarding's job, not ours.
export const NEW_PLAYER_GRACE_MS = 60 * 60 * 1000;

export function toTime(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

export function daysBetween(fromMs, toMs) {
  return Math.floor((toMs - fromMs) / DAY_MS);
}

/** Highest tier the player reached; the lowest tier when they only reached minDaysAway. */
export function pickTier(tiers, days) {
  const sorted = (Array.isArray(tiers) ? tiers : [])
    .filter((t) => t && Number.isFinite(Number(t.minDays)))
    .sort((a, b) => Number(a.minDays) - Number(b.minDays));
  if (sorted.length === 0) return null;
  let chosen = sorted[0];
  for (const tier of sorted) {
    if (days >= Number(tier.minDays)) chosen = tier;
  }
  return chosen;
}

/** Monday 00:00 UTC of the week `ms` falls in, as YYYY-MM-DD. */
export function weekStart(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

export function fill(template, values) {
  return String(template || '').replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

export async function getSetting(key, gameServerId, fallback) {
  try {
    const res = await takaro.settings.settingsControllerGetOne(key, gameServerId);
    const value = res.data.data.value;
    return value === undefined || value === null || value === '' ? fallback : value;
  } catch (err) {
    console.log(`welcome-back: could not read setting ${key}: ${err}`);
    return fallback;
  }
}

export async function findVariable(key, gameServerId, moduleId, playerId) {
  const filters = { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] };
  if (playerId) filters.playerId = [playerId];
  const res = await takaro.variable.variableControllerSearch({ filters });
  return res.data.data[0] || null;
}

export function parseJson(variable, fallback) {
  if (!variable || !variable.value) return fallback;
  try {
    return JSON.parse(variable.value);
  } catch {
    return fallback;
  }
}

export async function saveVariable(existing, body) {
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: body.value });
  } else {
    await takaro.variable.variableControllerCreate(body);
  }
}

/**
 * Takes a short-lived per-player lock. Takaro often fires player-connected several times
 * within seconds; the variable's unique key makes only one of those runs win.
 */
export async function takeLock(gameServerId, moduleId, playerId, nowMs) {
  try {
    await takaro.variable.variableControllerCreate({
      key: LOCK_KEY,
      value: String(nowMs),
      gameServerId,
      moduleId,
      playerId,
      expiresAt: new Date(nowMs + 5 * 60 * 1000).toISOString(),
    });
    return true;
  } catch (err) {
    if (String(err && err.message).includes('409')) return false;
    throw err;
  }
}

/** Adds one return to this week's counters and keeps the last MAX_WEEKS weeks. */
export async function recordReturn(gameServerId, moduleId, nowMs, rewarded, currency) {
  const existing = await findVariable(STATS_KEY, gameServerId, moduleId);
  const stats = parseJson(existing, {});
  const week = weekStart(nowMs);
  const entry = stats[week] || { returns: 0, rewarded: 0, currency: 0 };
  entry.returns += 1;
  if (rewarded) entry.rewarded += 1;
  entry.currency += currency;
  stats[week] = entry;
  const keep = Object.keys(stats).sort().slice(-MAX_WEEKS);
  const trimmed = {};
  for (const k of keep) trimmed[k] = stats[k];
  await saveVariable(existing, {
    key: STATS_KEY,
    value: JSON.stringify(trimmed),
    gameServerId,
    moduleId,
  });
}
