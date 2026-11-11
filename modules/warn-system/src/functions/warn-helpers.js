import { takaro } from '@takaro/helpers';

export const WARN_KEY = 'warn_system_warnings';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Keeps the variable value small; a player with this many stored warnings is long past every ladder step.
const MAX_STORED = 100;
const MAX_REASON = 200;
// Kick and ban reasons are capped at 150 characters by the Takaro API.
const MAX_ACTION_REASON = 150;

export function renderTemplate(template, values) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

export async function getPrefix(gameServerId) {
  try {
    const res = await takaro.settings.settingsControllerGetOne('commandPrefix', gameServerId);
    return res.data.data.value || '/';
  } catch {
    return '/';
  }
}

export async function getPlayerName(playerId, fallback = 'Unknown player') {
  try {
    const res = await takaro.player.playerControllerGetOne(playerId);
    return res.data.data.name || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Takaro hands a `string` argument only the first word, so the full reason is read from the raw chat
 * line with Takaro's own tokenizer: everything after the command and the player token.
 */
export function parseReason(rawMessage, fallback) {
  const tokens = typeof rawMessage === 'string' ? rawMessage.match(/(?:[^\s"]+|"[^"]*")+/g) : null;
  const fromChat = tokens && tokens.length > 2 ? tokens.slice(2).join(' ').replace(/"/g, '').trim() : '';
  const reason = fromChat || String(fallback ?? '').trim();
  return reason.slice(0, MAX_REASON);
}

export function formatDate(iso) {
  return String(iso).slice(0, 10);
}

export function isActive(warning, expiryDays, now) {
  if (!expiryDays || expiryDays <= 0) return true;
  return new Date(warning.createdAt).getTime() + expiryDays * DAY_MS > now;
}

export function daysLeft(warning, expiryDays, now) {
  if (!expiryDays || expiryDays <= 0) return null;
  const ms = new Date(warning.createdAt).getTime() + expiryDays * DAY_MS - now;
  return Math.max(1, Math.ceil(ms / DAY_MS));
}

export async function loadRecord(gameServerId, moduleId, playerId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: {
      key: [WARN_KEY],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
      playerId: [playerId],
    },
  });
  const row = res.data.data[0];
  let record = { nextId: 1, warnings: [] };
  if (row) {
    try {
      const parsed = JSON.parse(row.value);
      record = {
        nextId: Number(parsed.nextId) > 0 ? Number(parsed.nextId) : 1,
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      };
    } catch {
      console.error(`warn-system: could not parse stored warnings of player ${playerId}, starting fresh`);
    }
  }
  return { variableId: row ? row.id : null, record };
}

export async function saveRecord(gameServerId, moduleId, playerId, variableId, record) {
  const value = JSON.stringify({
    nextId: record.nextId,
    warnings: record.warnings.slice(-MAX_STORED),
  });
  if (variableId) {
    await takaro.variable.variableControllerUpdate(variableId, { value });
    return variableId;
  }
  const res = await takaro.variable.variableControllerCreate({
    key: WARN_KEY,
    value,
    gameServerId,
    moduleId,
    playerId,
  });
  return res.data.data.id;
}

/** Drops expired warnings and returns how many were removed. */
export function pruneExpired(record, expiryDays, now) {
  const before = record.warnings.length;
  record.warnings = record.warnings.filter((w) => isActive(w, expiryDays, now));
  return before - record.warnings.length;
}

/** The ladder step whose count is reached exactly; the last listed wins when several match. */
export function pickEscalation(steps, count) {
  const matching = (Array.isArray(steps) ? steps : []).filter((s) => Number(s.warnings) === count);
  return matching.length ? matching[matching.length - 1] : null;
}

/** The next step above `count`, for "next: 5 warnings = 24h ban" hints. */
export function nextEscalation(steps, count) {
  const above = (Array.isArray(steps) ? steps : [])
    .filter((s) => Number(s.warnings) > count)
    .sort((a, b) => a.warnings - b.warnings);
  return above[0] ?? null;
}

export function describeStep(step) {
  if (!step) return '';
  if (step.action === 'kick') return 'kick';
  if (step.action === 'tempban') return `${step.durationHours ?? 24}h ban`;
  return 'permanent ban';
}

export async function sendTo(gameServerId, gameId, message) {
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message,
    opts: { recipient: { gameId } },
  });
}

export async function broadcast(gameServerId, message) {
  try {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message });
  } catch (err) {
    console.error(`warn-system: broadcast failed: ${err}`);
  }
}

export async function discordLog(channelId, message) {
  const id = String(channelId ?? '').trim();
  if (!id) return;
  try {
    await takaro.discord.discordControllerSendMessage(id, { message });
  } catch (err) {
    console.error(`warn-system: Discord log to channel ${id} failed: ${err}`);
  }
}

/**
 * Runs one ladder step against the target. Never throws: returns a short result line for the staff
 * member, so a failed kick (offline player, game without kick support) does not undo the warning.
 */
export async function applyEscalation({ step, gameServerId, target, targetName, count, reason, now }) {
  const actionReason = `Warning limit reached (${count}): ${reason}`.slice(0, MAX_ACTION_REASON);

  if (step.action === 'kick') {
    if (target.online === false) {
      return { ok: false, text: `${targetName} reached ${count} warnings but is offline, so was not kicked.` };
    }
    try {
      await takaro.gameserver.gameServerControllerKickPlayer(gameServerId, target.playerId, { reason: actionReason });
      return { ok: true, text: `${targetName} reached ${count} warnings and was kicked.` };
    } catch (err) {
      console.error(`warn-system: kick failed for ${target.playerId}: ${err}`);
      return { ok: false, text: `${targetName} reached ${count} warnings, but the kick failed (the game may not support it).` };
    }
  }

  const isTemp = step.action === 'tempban';
  const hours = Number(step.durationHours) > 0 ? Number(step.durationHours) : 24;
  const body = {
    gameServerId,
    playerId: target.playerId,
    reason: actionReason,
  };
  if (isTemp) body.until = new Date(now + hours * HOUR_MS).toISOString();

  try {
    await takaro.player.banControllerCreate(body);
    return {
      ok: true,
      text: isTemp
        ? `${targetName} reached ${count} warnings and was banned for ${hours}h.`
        : `${targetName} reached ${count} warnings and was banned permanently.`,
    };
  } catch (err) {
    console.error(`warn-system: ban failed for ${target.playerId}: ${err}`);
    return { ok: false, text: `${targetName} reached ${count} warnings, but the ban failed. Please ban manually.` };
  }
}

/**
 * Finds one player on this game server by (partial) name, like Takaro's own `player` argument.
 * An exact, case-insensitive name match wins when the search returns several players.
 */
export async function resolvePlayerByName(gameServerId, input) {
  const search = await takaro.player.playerControllerSearch({ search: { name: [input] }, limit: 50 });
  const candidates = search.data.data;
  if (!candidates.length) return { error: `No player found with the name "${input}".` };

  const pogs = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: { gameServerId: [gameServerId], playerId: candidates.map((p) => p.id) },
    limit: 50,
  });
  const onServer = new Set(pogs.data.data.map((p) => p.playerId));
  const here = candidates.filter((p) => onServer.has(p.id));
  if (!here.length) return { error: `No player found with the name "${input}" on this server.` };

  const exact = here.filter((p) => String(p.name).toLowerCase() === input.toLowerCase());
  if (exact.length === 1) return { playerId: exact[0].id, name: exact[0].name };
  if (here.length === 1) return { playerId: here[0].id, name: here[0].name };
  return { error: `Several players match "${input}". Please type more of the name.` };
}
