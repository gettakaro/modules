import { takaro } from '@takaro/helpers';

export const STATUS_MESSAGE_KEY_PREFIX = 'discord7d2d:statusMessage:';
export const BLOOD_STATE_KEY = 'discord7d2d:bloodState';

export const MESSAGE_PRESETS = {
  en: {
    joinMessageTemplate: '{player} joined the game.',
    leaveMessageTemplate: '{player} left the game.',
    deathMessageTemplate: '{player} died.',
    deathWithReasonMessageTemplate: '{player} died: {reason}',
    bloodMoonTodayMessage: 'Today is the Blood Moon day...',
    bloodMoonStartingMessage: 'Blood Moon is starting...',
    bloodMoonEndingMessage: 'Blood Moon is ending...',
    serverStartingMessageTemplate: 'Server starting...',
    serverOfflineMessageTemplate: 'Server is offline.',
    statusTemplate: '{onlinePlayers} online ⭒ Day {day} ⭒ {time}{bloodMoonIcon}\nPlayers:\n{playerList}',
    emptyPlayerListText: 'Nobody online',
    unknownPlayerText: 'Player',
  },
  pl: {
    joinMessageTemplate: '{player} dołącza do gry.',
    leaveMessageTemplate: '{player} opuszcza grę.',
    deathMessageTemplate: '{player} nie żyje.',
    deathWithReasonMessageTemplate: '{player} nie żyje: {reason}',
    bloodMoonTodayMessage: 'Dzisiaj zapowiadają Krwawy Księżyc...',
    bloodMoonStartingMessage: 'Krwawy Księżyc wschodzi...',
    bloodMoonEndingMessage: 'Krwawy Księżyc zachodzi...',
    serverStartingMessageTemplate: 'Serwer startuje...',
    serverOfflineMessageTemplate: 'Serwer wyłączony.',
    statusTemplate: '{onlinePlayers} os. ⭒ Dzień {day} ⭒ {time}{bloodMoonIcon}\nLista graczy:\n{playerList}',
    emptyPlayerListText: 'Brak graczy online',
    unknownPlayerText: 'Gracz',
  },
};

export function getLanguage(config = {}) {
  return Object.hasOwn(MESSAGE_PRESETS, config.language) ? config.language : 'en';
}

export function resolveMessage(config = {}, key) {
  const override = config[key];
  if (typeof override === 'string' && override.trim()) return override;
  const language = getLanguage(config);
  return MESSAGE_PRESETS[language]?.[key] ?? MESSAGE_PRESETS.en[key] ?? '';
}

export function renderMessage(config, key, values = {}) {
  let rendered = resolveMessage(config, key);
  for (const [placeholder, value] of Object.entries(values)) {
    rendered = rendered.split(`{${placeholder}}`).join(String(value ?? ''));
  }
  const unknown = [...new Set(rendered.match(/\{[A-Za-z][A-Za-z0-9]*\}/g) ?? [])];
  if (unknown.length > 0) {
    console.warn(`discord-7d2d-status: unknown template placeholders: ${unknown.join(', ')}`);
  }
  return rendered;
}

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

export async function getOnlinePlayers(gameServerId) {
  const limit = 100;
  const records = [];
  let page = 0;
  let total = 0;
  do {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], online: [true] },
      extend: ['player'],
      limit,
      page,
    });
    records.push(...res.data.data);
    total = res.data.meta?.total ?? records.length;
    page += 1;
  } while (records.length < total);

  const playerNames = records
    .map((record) => record.player?.name || record.gameId)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  return { onlinePlayers: total, playerNames };
}

export async function getOnlineCount(gameServerId) {
  return (await getOnlinePlayers(gameServerId)).onlinePlayers;
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

export async function getTimeStatus(gameServerId, config) {
  const rawTime = await executeTimeCommand(gameServerId, config.timeConsoleCommand ?? 'gettime');
  const parsed = parse7d2dTime(rawTime);
  if (!parsed) console.warn(`discord-7d2d-status: could not parse 7D2D time: ${rawTime}`);
  const day = parsed?.day ?? '?';
  const time = parsed?.time ?? '?';
  const active = isBloodMoonActive(parsed, config.firstHordeDay ?? 7, config.hordeIntervalDays ?? 7, config.bloodMoonStartHour ?? 22, config.bloodMoonEndHour ?? 4);
  return { rawTime, parsed, day, time, bloodMoonActive: active };
}

export async function getStatus(gameServerId, config) {
  const [players, serverName, timeStatus] = await Promise.all([
    getOnlinePlayers(gameServerId),
    getServerName(gameServerId),
    getTimeStatus(gameServerId, config),
  ]);
  return { ...players, serverName, ...timeStatus };
}

export function renderTemplate(template, status, config) {
  const effectiveConfig = typeof template === 'string' && template.trim()
    ? { ...config, statusTemplate: template }
    : config;
  const bloodMoonIcon = status.bloodMoonActive ? (config.bloodMoonIcon ?? ' ⭒ 🩸') : '';
  const playerList = status.playerNames?.length
    ? status.playerNames.join('\n')
    : resolveMessage(config, 'emptyPlayerListText');
  return renderMessage(effectiveConfig, 'statusTemplate', {
    onlinePlayers: status.onlinePlayers,
    playerList,
    serverName: status.serverName,
    day: status.day,
    time: status.time,
    bloodMoonIcon,
  });
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

function discordErrorStatus(err) {
  const status = err?.response?.status ?? err?.status;
  return Number.isInteger(status) ? status : null;
}

function safeIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

function discordApiError(err) {
  const value = err?.response?.data?.meta?.error;
  return value && typeof value === 'object' ? value : null;
}

function discordErrorCode(err) {
  const apiError = discordApiError(err);
  if (!apiError) return null;
  for (const value of [apiError.code, apiError.message, apiError.details]) {
    if (Number.isInteger(value) && value >= 1000) return value;
    if (typeof value !== 'string') continue;
    if (/^\d{4,6}$/.test(value)) return Number(value);
    const match = value.match(/(?:DiscordAPIError|discord(?:\s+error)?\s+code|["']?code["']?)[^0-9]{0,16}(\d{4,6})/i);
    if (match) return Number(match[1]);
  }
  return null;
}

function safeDiscordCause(err) {
  const details = [];
  const status = discordErrorStatus(err);
  const discordCode = discordErrorCode(err);
  const takaroCode = safeIdentifier(discordApiError(err)?.code);
  const requestCode = safeIdentifier(err?.code);
  if (status !== null) details.push(`HTTP ${status}`);
  if (discordCode !== null) details.push(`Discord code ${discordCode}`);
  if (takaroCode && !/^\d+$/.test(takaroCode)) details.push(`Takaro code ${takaroCode}`);
  if (requestCode) details.push(`request code ${requestCode}`);
  return new Error(details.length > 0 ? `Discord request failed (${details.join(', ')})` : 'Discord request failed');
}

function errorWithSafeCause(message, err) {
  try {
    return new Error(message, { cause: safeDiscordCause(err) });
  } catch (_err) {
    return new Error(message);
  }
}

export function normalizeDiscordError(channelId, err) {
  const status = discordErrorStatus(err);
  const discordCode = discordErrorCode(err);
  const codeText = discordCode === null ? '' : `, Discord code ${discordCode}`;
  const guidance = 'verify the Discord guild is enabled and authorized in Takaro; use a normal text channel and grant the Takaro bot View Channel, Send Messages, and Read Message History; private or archived threads may still reject the bot.';
  if (discordCode === 10008) {
    const errorDetails = status === null ? 'Discord code 10008' : `HTTP ${status}, Discord code 10008`;
    return errorWithSafeCause(`Discord reported Unknown Message for the prior status message in channel ${channelId} (${errorDetails}): the previous status message no longer exists.`, err);
  }
  if (status === 403) {
    return errorWithSafeCause(`Takaro or Discord refused delivery to channel ${channelId} (HTTP 403${codeText}): ${guidance}`, err);
  }
  if (status === 404) {
    return errorWithSafeCause(`Discord channel ${channelId} or its guild was not found or is unavailable to the Takaro bot (HTTP 404${codeText}): ${guidance}`, err);
  }

  const statusText = status === null ? '' : ` (HTTP ${status})`;
  const requestCode = safeIdentifier(err?.code);
  const reason = requestCode ? `: request code ${requestCode}` : '';
  return errorWithSafeCause(`Discord delivery to channel ${channelId} failed${statusText}${reason}`, err);
}

function shouldReplaceMissingMessage(err) {
  return discordErrorCode(err) === 10008;
}

export async function sendDiscord(channelId, message) {
  const safeMessage = sanitizeDiscordMessage(message);
  if (!channelId) {
    console.log(`discord-7d2d-status: no Discord channel configured, skipped message: ${safeMessage}`);
    return null;
  }
  try {
    return await takaro.discord.discordControllerSendMessage(channelId, { message: safeMessage });
  } catch (err) {
    throw normalizeDiscordError(channelId, err);
  }
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
      const reason = normalizeDiscordError(channelId, err);
      if (!shouldReplaceMissingMessage(err)) throw reason;
      console.error(`discord-7d2d-status: prior Discord status message ${existingId} is missing, sending replacement: ${reason.message}`);
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
