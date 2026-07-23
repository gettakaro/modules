import { data } from '@takaro/helpers';
import { BLOOD_STATE_KEY, getDiscordChannelFromHook, getTimeStatus, isBloodMoonDay, readVariable, resolveMessage, sendDiscord, writeVariable } from './discord-7d2d-status-helpers.js';

function phaseFor(status, config) {
  const parsed = status.parsed;
  if (!parsed) return { key: 'unknown', messageKey: null };
  const first = config.firstHordeDay ?? 7;
  const interval = config.hordeIntervalDays ?? 7;
  const start = config.bloodMoonStartHour ?? 22;
  const end = config.bloodMoonEndHour ?? 4;
  if (isBloodMoonDay(parsed.day, first, interval) && parsed.hour !== null && parsed.hour >= start) return { key: `start:${parsed.day}`, messageKey: 'bloodMoonStartingMessage' };
  if (parsed.hour !== null && parsed.hour < end && parsed.day > 1 && isBloodMoonDay(parsed.day - 1, first, interval)) return { key: `start:${parsed.day - 1}`, messageKey: null };
  if (parsed.hour !== null && parsed.hour >= end && parsed.day > 1 && isBloodMoonDay(parsed.day - 1, first, interval)) return { key: `end:${parsed.day - 1}`, messageKey: 'bloodMoonEndingMessage' };
  if (isBloodMoonDay(parsed.day, first, interval)) return { key: `today:${parsed.day}`, messageKey: 'bloodMoonTodayMessage' };
  return { key: `normal:${parsed.day}`, messageKey: null };
}

async function main() {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const channelId = getDiscordChannelFromHook(data, config.monitoringChannelId, 'bloodMoonMonitor');
  const status = await getTimeStatus(gameServerId, config);
  const phase = phaseFor(status, config);
  const prev = await readVariable(gameServerId, mod.moduleId, BLOOD_STATE_KEY, null);
  if (prev === phase.key) return;
  if (phase.messageKey) await sendDiscord(channelId, resolveMessage(config, phase.messageKey));
  await writeVariable(gameServerId, mod.moduleId, BLOOD_STATE_KEY, phase.key);
}

await main();
