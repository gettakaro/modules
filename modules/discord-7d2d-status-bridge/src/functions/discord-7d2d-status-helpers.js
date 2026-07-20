import { takaro } from '@takaro/helpers';

export const STATUS_MESSAGE_KEY_PREFIX = 'discord7d2d:statusMessage:';
export const BLOOD_STATE_KEY = 'discord7d2d:bloodState';

export function parse7d2dTime(raw) {
  const text = String(raw ?? '');
  const dayMatch = text.match(/\bDay\s*:?\s*(\d+)\b/i) || text.match(/\bD\s*:?\s*(\d+)\b/i) || text.match(/(?:Game|World)\s*time.*?\b(\d+)\b/i);
  if (!dayMatch) return null;
  const timeMatch = text.match(/\b(\d{1,2}):(\d{2})\b/);
  const day = Number(dayMatch[1]);
  const hour = timeMatch ? Number(timeMatch[1]) : null;
  const minute = timeMatch ? Number(timeMatch[2]) : null;
  if (!Number.isFinite(day) || day < 1) return null;
  if (hour !== null && (hour < 0 || hour > 23 || minute < 0 || minute > 59)) return null;
  return { day, hour, minute, time: timeMatch ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : '?' };
}

export function nextHordeDay(currentDay, firstHordeDay = 7, interval = 7) {
  if (currentDay <= firstHordeDay) return firstHordeDay;
  return firstHordeDay + Math.ceil((currentDay - firstHordeDay) / interval) * interval;
}

export function isBloodMoonDay(day, firstHordeDay = 7, interval = 7) {
  return nextHordeDay(day, firstHordeDay, interval) === day;
}

export function isBloodMoonActive(parsed, firstHordeDay = 7, interval = 7, startHour = 22, endHour = 4) {
  if (!parsed || parsed.hour === null) return false;
  if (isBloodMoonDay(parsed.day, firstHordeDay, interval) && parsed.hour >= startHour) return true;
  if (parsed.hour < endHour && parsed.day > 1 && isBloodMoonDay(parsed.day - 1, firstHordeDay, interval)) return true;
  return false;
}

export async function getOnlineCount(gameServerId) {
  const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: { gameServerId: [gameServerId], online: [true] },
    limit: 1,
  });
  return res.data.meta?.total ?? res.data.data.length;
}

export async function getServerName(gameServerId) {
  try {
    const res = await takaro.gameserver.gameServerControllerGetOne(gameServerId);
    return res.data.data?.name ?? 'Server';
  } catch (err) {
    console.error(`discord-7d2d-status: failed to fetch server name: ${err}`);
    return 'Server';
  }
}

export async function executeTimeCommand(gameServerId, command = 'gettime') {
  const res = await takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, { command });
  const data = res?.data?.data ?? res?.data ?? res;
  if (typeof data === 'string') return data;
  if (data?.response) return data.response;
  if (data?.result) return data.result;
  if (data?.message) return data.message;
  return JSON.stringify(data);
}

export async function getStatus(gameServerId, config) {
  const [onlinePlayers, serverName, rawTime] = await Promise.all([
    getOnlineCount(gameServerId),
    getServerName(gameServerId),
    executeTimeCommand(gameServerId, config.timeConsoleCommand ?? 'gettime'),
  ]);
  const parsed = parse7d2dTime(rawTime);
  const day = parsed?.day ?? '?';
  const time = parsed?.time ?? '?';
  const active = isBloodMoonActive(parsed, config.firstHordeDay ?? 7, config.hordeIntervalDays ?? 7, config.bloodMoonStartHour ?? 22, config.bloodMoonEndHour ?? 4);
  return { onlinePlayers, serverName, rawTime, parsed, day, time, bloodMoonActive: active };
}

export function renderTemplate(template, status, config) {
  const bloodMoonIcon = status.bloodMoonActive ? (config.bloodMoonIcon ?? ' ⭔ 🩸') : '';
  return String(template ?? '{onlinePlayers} os. ⭔ Dzień {day} ⭔ {time}{bloodMoonIcon}')
    .replace(/\{onlinePlayers\}/g, String(status.onlinePlayers))
    .replace(/\{serverName\}/g, String(status.serverName))
    .replace(/\{day\}/g, String(status.day))
    .replace(/\{time\}/g, String(status.time))
    .replace(/\{bloodMoonIcon\}/g, bloodMoonIcon);
}

async function findVariable(gameServerId, moduleId, key) {
  const res = await takaro.variable.variableControllerSearch({ filters: { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] }, limit: 1 });
  return res.data.data[0] ?? null;
}

export async function readVariable(gameServerId, moduleId, key, fallback = null) {
  const record = await findVariable(gameServerId, moduleId, key);
  if (!record) return fallback;
  try { return JSON.parse(record.value); } catch (_err) { return fallback; }
}

export async function writeVariable(gameServerId, moduleId, key, value) {
  const existing = await findVariable(gameServerId, moduleId, key);
  const serialized = JSON.stringify(value);
  if (existing) await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
  else await takaro.variable.variableControllerCreate({ key, value: serialized, gameServerId, moduleId });
}

export function getDiscordChannelFromHook(data, configuredChannelId, hookName) {
  if (configuredChannelId) return configuredChannelId;
  return data?.module?.systemConfig?.hooks?.[hookName]?.discordChannelId || data?.discordChannelId || data?.eventData?.discordChannelId || data?.eventData?.channelId || '';
}

export async function sendDiscord(channelId, message) {
  if (!channelId) {
    console.log(`discord-7d2d-status: no Discord channel configured, skipped message: ${message}`);
    return null;
  }
  return takaro.discord.discordControllerSendMessage(channelId, { message: sanitizeDiscordMessage(message) });
}

export function sanitizeDiscordMessage(message) {
  const withoutMentions = String(message ?? '')
    .replace(/@everyone/g, '@\u200beveryone')
    .replace(/@here/g, '@\u200bhere')
    .replace(/<@!?(\d+)>/g, '<@\u200b$1>')
    .replace(/<@&(\d+)>/g, '<@&\u200b$1>');
  if (withoutMentions.length <= 1900) return withoutMentions;
  return `${withoutMentions.slice(0, 1897)}...`;
}

export function isGlobalChatMessage(eventData) {
  if (!eventData) return false;
  if (eventData.isPrivate === true || eventData.private === true) return false;
  if (eventData.recipient || eventData.target || eventData.to || eventData.whisperTarget) return false;
  const rawScope = eventData.channel ?? eventData.chatChannel ?? eventData.chatType ?? eventData.type ?? eventData.scope ?? eventData.chatMessage?.channel ?? eventData.chatMessage?.type;
  if (rawScope === undefined || rawScope === null || rawScope === '') return false;
  return ['global', 'public', 'all'].includes(String(rawScope).toLowerCase());
}

export function isDiscordRelayEcho(eventData) {
  const text = pickText(eventData?.msg, eventData?.message, eventData?.text, eventData?.chatMessage?.message);
  return /^\[discord\]\s+/i.test(text);
}

export async function updatePersistentDiscordMessage(gameServerId, moduleId, channelId, message) {
  const safeMessage = sanitizeDiscordMessage(message);
  const key = `${STATUS_MESSAGE_KEY_PREFIX}${channelId}`;
  const existingId = await readVariable(gameServerId, moduleId, key, null);
  if (existingId) {
    try {
      await takaro.discord.discordControllerUpdateMessage(channelId, existingId, { message: safeMessage });
      return existingId;
    } catch (err) {
      console.error(`discord-7d2d-status: failed to update Discord status message ${existingId}, sending replacement: ${err}`);
    }
  }
  const sent = await sendDiscord(channelId, safeMessage);
  const messageId = sent?.data?.data?.id;
  if (messageId) await writeVariable(gameServerId, moduleId, key, messageId);
  return messageId ?? null;
}

export function pickText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function pickAuthorName(eventData) {
  return pickText(eventData?.author?.username, eventData?.author?.globalName, eventData?.username, eventData?.userName, eventData?.member?.displayName, 'Discord');
}
