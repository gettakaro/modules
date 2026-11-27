import { takaro } from '@takaro/helpers';

export const STATE_KEY = 'restart_manager_state';
export const PVP_KEY = 'restart_manager_last_pvp';
export const MANAGE_PERMISSION = 'RESTART_MANAGER_MANAGE';
export const MINUTE_MS = 60 * 1000;
// The tick cron fires a few seconds early or late. Anything due within this slack counts as due.
export const TICK_SLACK_MS = 15 * 1000;
// A countdown whose restart time passed this long ago (Takaro or the server was down) is dropped.
export const STALE_MS = 15 * MINUTE_MS;

// ---------- variables ----------

async function findVariable(key, gameServerId, moduleId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] },
  });
  return res.data.data.length > 0 ? res.data.data[0] : null;
}

async function writeVariable(key, value, gameServerId, moduleId) {
  const existing = await findVariable(key, gameServerId, moduleId);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value });
  } else {
    await takaro.variable.variableControllerCreate({ key, value, gameServerId, moduleId });
  }
}

export async function getState(gameServerId, moduleId) {
  const variable = await findVariable(STATE_KEY, gameServerId, moduleId);
  if (!variable) return { pending: null };
  try {
    return { pending: null, ...JSON.parse(variable.value) };
  } catch (err) {
    console.error(`restart-manager: could not parse state, starting fresh: ${err}`);
    return { pending: null };
  }
}

export async function setState(gameServerId, moduleId, state) {
  await writeVariable(STATE_KEY, JSON.stringify(state), gameServerId, moduleId);
}

export async function getLastPvpAt(gameServerId, moduleId) {
  const variable = await findVariable(PVP_KEY, gameServerId, moduleId);
  const ms = variable ? new Date(variable.value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export async function setLastPvpAt(gameServerId, moduleId, ms) {
  await writeVariable(PVP_KEY, new Date(ms).toISOString(), gameServerId, moduleId);
}

// ---------- settings / text ----------

export async function getSetting(key, gameServerId, fallback) {
  try {
    const res = await takaro.settings.settingsControllerGetOne(key, gameServerId);
    const value = res.data.data.value;
    return value === undefined || value === null || value === '' ? fallback : value;
  } catch (err) {
    console.log(`restart-manager: setting ${key} unavailable, using '${fallback}'`);
    return fallback;
  }
}

export function fill(template, values) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) =>
    values[key] === undefined ? match : String(values[key]),
  );
}

function unit(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "1 minute", "30 minutes", "1 hour 30 minutes", "2 days 3 hours". Rounds to whole minutes, at least 1. */
export function humanDuration(ms) {
  const total = Math.max(1, Math.round(ms / MINUTE_MS));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days > 0) return hours > 0 ? `${unit(days, 'day')} ${unit(hours, 'hour')}` : unit(days, 'day');
  if (hours > 0) return minutes > 0 ? `${unit(hours, 'hour')} ${unit(minutes, 'minute')}` : unit(hours, 'hour');
  return unit(minutes, 'minute');
}

/** Warning minutes from the config: positive whole numbers, biggest first, no doubles. */
export function warningList(config) {
  const list = (config.warningMinutes || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(list.map((n) => Math.round(n)))].sort((a, b) => b - a);
}

// ---------- messaging ----------

export async function broadcast(gameServerId, message) {
  if (!message) return;
  try {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message, opts: {} });
  } catch (err) {
    console.error(`restart-manager: broadcast failed: ${err}`);
  }
}

export async function announceDiscord(config, message) {
  const channelId = String(config.discordChannelId || '').trim();
  if (!channelId || !message) return;
  try {
    await takaro.discord.discordControllerSendMessage(channelId, { message });
  } catch (err) {
    console.error(`restart-manager: Discord announcement failed: ${err}`);
  }
}

/** Sends the countdown warning for a restart `remainingMs` away. */
export async function sendWarning(gameServerId, config, remainingMs, ctx, toDiscord) {
  const message = fill(config.warningMessage, {
    time: humanDuration(remainingMs),
    minutes: Math.max(1, Math.round(remainingMs / MINUTE_MS)),
    prefix: ctx.prefix,
  });
  await broadcast(gameServerId, message);
  if (toDiscord) await announceDiscord(config, message);
}

// ---------- game type and commands ----------

export async function getGameType(gameServerId) {
  try {
    const res = await takaro.gameserver.gameServerControllerGetOne(gameServerId);
    return String(res.data.data.type || '');
  } catch (err) {
    console.error(`restart-manager: could not read the game type: ${err}`);
    return '';
  }
}

/** Which entry of the gameCommands config applies to this Takaro game server type. */
export function gameKey(type) {
  switch (type) {
    case 'SEVENDAYSTODIE':
      return 'sevenDaysToDie';
    case 'RUST':
      return 'rust';
    case 'MINECRAFT':
      return 'minecraft';
    default:
      return 'other';
  }
}

export async function runConsole(gameServerId, command) {
  const res = await takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, { command });
  const result = res && res.data && res.data.data ? res.data.data : {};
  return String(result.rawResult ?? '');
}

// ---------- safe window ----------

/**
 * 7 Days to Die blood moon check. Reads the game time with `gettime` ("Day 14, 21:30") and the next
 * blood moon day with `ggs BloodMoonDay`. When the game stat is not readable it falls back to
 * "every N days" from the config. Returns true while the horde night window is on.
 */
export async function bloodMoonActive(gameServerId, config) {
  const timeText = await runConsole(gameServerId, 'gettime');
  const match = timeText.match(/Day\s*(\d+)\D+?(\d{1,2}):(\d{2})/i);
  if (!match) {
    console.log(`restart-manager: could not read the game time from 'gettime': ${JSON.stringify(timeText.slice(0, 200))}`);
    return false;
  }
  const day = Number(match[1]);
  const hour = Number(match[2]);
  const startHour = Number(config.bloodMoonStartHour);
  const endHour = Number(config.bloodMoonEndHour);

  let bloodMoonDay = null;
  try {
    const statText = await runConsole(gameServerId, 'ggs BloodMoonDay');
    const stat = statText.match(/BloodMoonDay\s*=\s*(\d+)/i);
    if (stat && Number(stat[1]) > 0) bloodMoonDay = Number(stat[1]);
  } catch (err) {
    console.log(`restart-manager: 'ggs BloodMoonDay' failed, using the frequency: ${err}`);
  }

  const frequency = Math.max(1, Number(config.bloodMoonFrequency) || 7);
  const isBloodMoonDay = (d) => (bloodMoonDay !== null ? d === bloodMoonDay : d > 0 && d % frequency === 0);
  const active = (isBloodMoonDay(day) && hour >= startHour) || (isBloodMoonDay(day - 1) && hour < endHour);
  console.log(
    `restart-manager: game time day ${day} ${hour}h, blood moon day ${bloodMoonDay ?? `every ${frequency}`}, horde window ${active ? 'ON' : 'off'}`,
  );
  return active;
}

export async function countOnline(gameServerId) {
  const players = [];
  let page = 0;
  while (true) {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], online: [true] },
      limit: 100,
      page,
    });
    players.push(...res.data.data);
    if (res.data.data.length < 100) break;
    page++;
  }
  return players;
}

/**
 * Returns why the restart should wait right now, or null when it is safe.
 * A check that errors does not block: a restart is often what a struggling server needs.
 */
export async function unsafeReason({ gameServerId, moduleId, config, gameType, now }) {
  const pvpMinutes = Number(config.pvpQuietMinutes) || 0;
  if (pvpMinutes > 0) {
    const lastPvp = await getLastPvpAt(gameServerId, moduleId);
    if (lastPvp !== null && now - lastPvp < pvpMinutes * MINUTE_MS) {
      return fill(config.pvpReason, { minutes: pvpMinutes });
    }
  }

  const playerLimit = Number(config.delayWhenPlayersOnline) || 0;
  if (playerLimit > 0) {
    try {
      const online = await countOnline(gameServerId);
      if (online.length >= playerLimit) return fill(config.playersReason, { count: online.length });
    } catch (err) {
      console.error(`restart-manager: online player check failed: ${err}`);
    }
  }

  if (config.bloodMoonDelay && gameType === 'SEVENDAYSTODIE') {
    try {
      if (await bloodMoonActive(gameServerId, config)) return config.bloodMoonReason;
    } catch (err) {
      console.error(`restart-manager: blood moon check failed: ${err}`);
    }
  }

  for (const [index, condition] of (config.consoleConditions || []).entries()) {
    const command = String(condition.command || '').trim();
    if (!command || !condition.pattern) continue;
    let regex;
    try {
      regex = new RegExp(condition.pattern, 'i');
    } catch (err) {
      console.error(`restart-manager: console condition #${index + 1} has an invalid pattern: ${err.message}`);
      continue;
    }
    try {
      const output = await runConsole(gameServerId, command);
      if (regex.test(output)) return condition.reason || 'the server is busy';
    } catch (err) {
      console.error(`restart-manager: console condition #${index + 1} ('${command}') failed: ${err}`);
    }
  }
  return null;
}

// ---------- the restart itself ----------

/**
 * Save, kick and shut down. The caller has already cleared the pending restart from the state,
 * so a failure here never loops.
 */
export async function executeRestart({ gameServerId, config, ctx }) {
  const gameType = await getGameType(gameServerId);
  const commands = (config.gameCommands || {})[gameKey(gameType)] || {};

  const message = fill(config.restartingMessage, { prefix: ctx.prefix });
  await broadcast(gameServerId, message);
  await announceDiscord(config, message);

  const saveCommand = String(commands.saveCommand || '').trim();
  if (config.saveBeforeShutdown && saveCommand) {
    try {
      const out = await runConsole(gameServerId, saveCommand);
      console.log(`restart-manager: '${saveCommand}' -> ${JSON.stringify(out.slice(0, 200))}`);
    } catch (err) {
      console.error(`restart-manager: save command '${saveCommand}' failed: ${err}`);
    }
  }

  if (config.kickAllBeforeShutdown) {
    let kicked = 0;
    try {
      const online = await countOnline(gameServerId);
      // Sequential on purpose: the module sandbox caps concurrent outbound requests.
      for (const pog of online) {
        try {
          await takaro.gameserver.gameServerControllerKickPlayer(gameServerId, pog.playerId, {
            reason: fill(config.kickMessage, { prefix: ctx.prefix }),
          });
          kicked++;
        } catch (err) {
          console.error(`restart-manager: kick of player ${pog.playerId} failed: ${err}`);
        }
      }
    } catch (err) {
      console.error(`restart-manager: could not list online players to kick: ${err}`);
    }
    console.log(`restart-manager: kicked ${kicked} player(s)`);
  }

  const shutdownCommand = String(commands.shutdownCommand || '').trim();
  try {
    if (shutdownCommand) {
      await runConsole(gameServerId, shutdownCommand);
      console.log(`restart-manager: ran shutdown command '${shutdownCommand}'`);
    } else {
      await takaro.gameserver.gameServerControllerShutdown(gameServerId);
      console.log('restart-manager: asked Takaro to shut the server down');
    }
  } catch (err) {
    console.error(`restart-manager: shutdown failed: ${err}`);
  }
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
  let formatter = null;
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
    console.error(`restart-manager: invalid timezone '${timeZone}', using UTC`);
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

/** The configured restart times that parse. Invalid ones are logged and skipped. */
export function compileSchedules(config) {
  const out = [];
  (config.schedules || []).forEach((expression, index) => {
    try {
      out.push({ index, expression, cron: parseCron(expression) });
    } catch (err) {
      console.error(`restart-manager: restart time #${index + 1} '${expression}' is not valid cron: ${err.message}`);
    }
  });
  return out;
}

/** First scheduled minute in [fromMs, toMs], or null. */
export function firstScheduledBetween(compiled, readZone, fromMs, toMs) {
  if (compiled.length === 0) return null;
  for (let m = floorMinute(fromMs); m <= toMs; m += MINUTE_MS) {
    if (m < fromMs) continue;
    const t = readZone(m);
    if (compiled.some((entry) => cronMatches(entry.cron, t))) return m;
  }
  return null;
}
