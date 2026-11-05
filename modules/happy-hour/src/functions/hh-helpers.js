import { takaro, checkPermission } from '@takaro/helpers';

export const STATE_KEY = 'happy_hour_state';
export const VIP_PERMISSION = 'HAPPY_HOUR_VIP_BONUS';
export const MINUTE_MS = 60 * 1000;
// The tick cron fires a few hundred ms to a few seconds early or late. A step that is due
// within this slack counts as due, so a 1-minute interval never skips a tick.
export const TICK_SLACK_MS = 15 * 1000;

/**
 * Interval step for a once-a-minute tick. Returns the new anchor (ISO) when a step is due, else null.
 * The anchor moves forward in whole intervals from the last one, so jitter never adds up and
 * missed ticks give one payout, not a burst.
 */
export function dueStep(lastIso, now, everyMs) {
  const last = new Date(lastIso).getTime();
  if (!Number.isFinite(last) || everyMs <= 0) return null;
  const steps = Math.floor((now - last + TICK_SLACK_MS) / everyMs);
  if (steps < 1) return null;
  return new Date(last + steps * everyMs).toISOString();
}
// A delayed or skipped tick still catches schedule matches from this far back.
const CATCH_UP_MINUTES = 10;

// ---------- state ----------

async function findStateVariable(gameServerId, moduleId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: { key: [STATE_KEY], gameServerId: [gameServerId], moduleId: [moduleId] },
  });
  return res.data.data.length > 0 ? res.data.data[0] : null;
}

export async function getState(gameServerId, moduleId) {
  const variable = await findStateVariable(gameServerId, moduleId);
  if (!variable) return { active: false };
  try {
    return { active: false, ...JSON.parse(variable.value) };
  } catch (err) {
    console.error(`happy-hour: could not parse state, treating as inactive: ${err}`);
    return { active: false };
  }
}

export async function setState(gameServerId, moduleId, state) {
  const value = JSON.stringify(state);
  const existing = await findStateVariable(gameServerId, moduleId);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value });
  } else {
    await takaro.variable.variableControllerCreate({ key: STATE_KEY, value, gameServerId, moduleId });
  }
}

/** True while an event runs. An event past its end counts as over even before the tick announces it. */
export function isRunning(state, now) {
  return Boolean(state && state.active && state.endsAt && new Date(state.endsAt).getTime() > now);
}

// ---------- settings / text ----------

export async function getSetting(key, gameServerId, fallback) {
  try {
    const res = await takaro.settings.settingsControllerGetOne(key, gameServerId);
    const value = res.data.data.value;
    return value === undefined || value === null || value === '' ? fallback : value;
  } catch (err) {
    console.log(`happy-hour: setting ${key} unavailable, using '${fallback}'`);
    return fallback;
  }
}

export async function getTextContext(gameServerId) {
  const prefix = await getSetting('commandPrefix', gameServerId, '/');
  const currency = await getSetting('currencyName', gameServerId, 'coins');
  return { prefix, currency };
}

export function fill(template, values) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) =>
    values[key] === undefined ? match : String(values[key]),
  );
}

export function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.ceil(ms / MINUTE_MS));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

export function formatMultiplier(multiplier) {
  return `x${Number(multiplier).toFixed(2).replace(/\.?0+$/, '')}`;
}

export function eventValues(state, now, ctx) {
  const remaining = new Date(state.endsAt).getTime() - now;
  return {
    multiplier: formatMultiplier(state.multiplier),
    minutes: Math.max(0, Math.ceil(remaining / MINUTE_MS)),
    timeLeft: formatDuration(remaining),
    currency: ctx.currency,
    prefix: ctx.prefix,
  };
}

// ---------- messaging ----------

export async function broadcast(gameServerId, message) {
  try {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message, opts: {} });
  } catch (err) {
    console.error(`happy-hour: broadcast failed: ${err}`);
  }
}

export async function pmGameId(gameServerId, gameId, message) {
  try {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message,
      opts: { recipient: { gameId } },
    });
  } catch (err) {
    console.error(`happy-hour: pm to ${gameId} failed: ${err}`);
  }
}

export async function announceDiscord(config, message) {
  if (!config.discordAnnounce) return;
  const channelId = String(config.discordChannelId || '').trim();
  if (!channelId) {
    console.log('happy-hour: discordAnnounce is on but discordChannelId is empty; skipping Discord.');
    return;
  }
  try {
    await takaro.discord.discordControllerSendMessage(channelId, { message });
  } catch (err) {
    console.error(`happy-hour: Discord announcement failed: ${err}`);
  }
}

// ---------- event lifecycle ----------

export async function startEvent({ gameServerId, moduleId, config, durationMinutes, multiplier, source, startedBy, startAt, now }) {
  const start = startAt ?? now;
  const state = {
    active: true,
    startedAt: new Date(start).toISOString(),
    endsAt: new Date(start + durationMinutes * MINUTE_MS).toISOString(),
    multiplier,
    source,
    startedBy: startedBy ?? null,
    lastReminderAt: new Date(now).toISOString(),
    lastPlaytimeAt: new Date(now).toISOString(),
  };
  const previous = await getState(gameServerId, moduleId);
  await setState(gameServerId, moduleId, { ...previous, ...state });

  const ctx = await getTextContext(gameServerId);
  const message = fill(config.startMessage, eventValues(state, now, ctx));
  await broadcast(gameServerId, message);
  await announceDiscord(config, message);
  return state;
}

export async function endEvent({ gameServerId, moduleId, config, state, reason }) {
  await setState(gameServerId, moduleId, {
    ...state,
    active: false,
    endedAt: new Date().toISOString(),
    endReason: reason,
  });
  const ctx = await getTextContext(gameServerId);
  const message = fill(config.endMessage, {
    multiplier: formatMultiplier(state.multiplier),
    currency: ctx.currency,
    prefix: ctx.prefix,
  });
  await broadcast(gameServerId, message);
  await announceDiscord(config, message);
}

// ---------- rewards ----------

/** Extra percent on the bonus from the HAPPY_HOUR_VIP_BONUS count (count 50 = +50%). */
export function vipPercent(pog) {
  if (!pog) return 0;
  const perm = checkPermission(pog, VIP_PERMISSION);
  return perm && typeof perm === 'object' && perm.count > 0 ? perm.count : 0;
}

/** bonus = base x (multiplier - 1), raised by the VIP percent, rounded to whole currency. */
export function bonusAmount(base, multiplier, extraPercent) {
  const raw = Number(base) * (Number(multiplier) - 1) * (1 + (extraPercent || 0) / 100);
  return raw > 0 ? Math.round(raw) : 0;
}

export async function economyEnabled(gameServerId) {
  const value = await getSetting('economyEnabled', gameServerId, 'true');
  return String(value) !== 'false';
}

// ---------- schedules (cron in a time zone) ----------

const NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function parseValue(token, min, max) {
  const lower = token.toLowerCase();
  const value = NAMES[lower] !== undefined ? NAMES[lower] : Number(token);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`value '${token}' outside ${min}-${max}`);
  }
  return value;
}

function parseField(field, min, max) {
  const allowed = new Set();
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in '${part}'`);
    let from;
    let to;
    if (range === '*') {
      from = min;
      to = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      from = parseValue(a, min, max);
      to = parseValue(b, min, max);
    } else {
      from = parseValue(range, min, max);
      to = stepText === undefined ? from : max;
    }
    for (let v = from; v <= to; v += step) allowed.add(v);
  }
  return { allowed, any: field === '*' };
}

/** Parses a 5-field cron expression (minute hour day-of-month month day-of-week). Throws on invalid input. */
export function parseCron(expression) {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`expected 5 fields, got ${fields.length}`);
  const dow = parseField(fields[4], 0, 7);
  if (dow.allowed.has(7)) dow.allowed.add(0);
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dom: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    dow,
  };
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function makeZoneReader(timeZone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
  } catch (err) {
    console.error(`happy-hour: invalid timezone '${timeZone}', using UTC`);
    formatter = null;
  }
  return (ms) => {
    if (!formatter) {
      const d = new Date(ms);
      return {
        minute: d.getUTCMinutes(),
        hour: d.getUTCHours(),
        dom: d.getUTCDate(),
        month: d.getUTCMonth() + 1,
        dow: d.getUTCDay(),
      };
    }
    const parts = {};
    for (const p of formatter.formatToParts(new Date(ms))) parts[p.type] = p.value;
    return {
      minute: Number(parts.minute),
      hour: Number(parts.hour) % 24,
      dom: Number(parts.day),
      month: Number(parts.month),
      dow: WEEKDAYS[parts.weekday],
    };
  };
}

export function cronMatches(cron, t) {
  if (!cron.minute.allowed.has(t.minute) || !cron.hour.allowed.has(t.hour) || !cron.month.allowed.has(t.month)) {
    return false;
  }
  const domOk = cron.dom.allowed.has(t.dom);
  const dowOk = cron.dow.allowed.has(t.dow);
  // Standard cron: when both day fields are restricted, either may match.
  if (!cron.dom.any && !cron.dow.any) return domOk || dowOk;
  return domOk && dowOk;
}

export function floorMinute(ms) {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** The configured schedules that parse, each with its cron compiled. Invalid ones are logged and skipped. */
export function compileSchedules(config) {
  const out = [];
  (config.schedules || []).forEach((schedule, index) => {
    try {
      out.push({ index, schedule, cron: parseCron(schedule.cron) });
    } catch (err) {
      console.error(`happy-hour: schedule #${index + 1} has an invalid cron '${schedule.cron}': ${err.message}`);
    }
  });
  return out;
}

/** Minute starts the tick should check: after the last tick, at most CATCH_UP_MINUTES back, up to now. */
export function minutesToCheck(lastTickAt, now) {
  const current = floorMinute(now);
  let from = current;
  if (lastTickAt) {
    const afterLast = floorMinute(new Date(lastTickAt).getTime()) + MINUTE_MS;
    from = Math.max(afterLast, current - (CATCH_UP_MINUTES - 1) * MINUTE_MS);
  }
  const minutes = [];
  for (let m = from; m <= current; m += MINUTE_MS) minutes.push(m);
  return minutes;
}

/** Next scheduled start within `horizonDays`, or null. */
export function nextScheduledStart(compiled, readZone, now, horizonDays = 8) {
  if (compiled.length === 0) return null;
  const end = now + horizonDays * 1440 * MINUTE_MS;
  for (let m = floorMinute(now) + MINUTE_MS; m <= end; m += MINUTE_MS) {
    const t = readZone(m);
    for (const entry of compiled) {
      if (cronMatches(entry.cron, t)) return { at: m, entry };
    }
  }
  return null;
}
