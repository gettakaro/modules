import { data } from '@takaro/helpers';
import { BLOOD_STATE_KEY, getDiscordChannelFromHook, getStatus, isBloodMoonDay, readVariable, sendDiscord, writeVariable } from './discord-7d2d-status-helpers.js';

function phaseFor(status, config) {
  const parsed = status.parsed;
  if (!parsed) return { key: 'unknown', message: null };
  const first = config.firstHordeDay ?? 7;
  const interval = config.hordeIntervalDays ?? 7;
  const start = config.bloodMoonStartHour ?? 22;
  const end = config.bloodMoonEndHour ?? 4;
  if (isBloodMoonDay(parsed.day, first, interval) && parsed.hour !== null && parsed.hour >= start) return { key: `start:${parsed.day}`, message: config.bloodMoonStartingMessage };
  if (parsed.hour !== null && parsed.hour < end && parsed.day > 1 && isBloodMoonDay(parsed.day - 1, first, interval)) return { key: `start:${parsed.day - 1}`, message: null };
  if (parsed.hour !== null && parsed.hour >= end && parsed.day > 1 && isBloodMoonDay(parsed.day - 1, first, interval)) return { key: `end:${parsed.day - 1}`, message: config.bloodMoonEndingMessage };
  if (isBloodMoonDay(parsed.day, first, interval)) return { key: `today:${parsed.day}`, message: config.bloodMoonTodayMessage };
  return { key: `normal:${parsed.day}`, message: null };
}

async function main() {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const channelId = getDiscordChannelFromHook(data, config.monitoringChannelId, 'bloodMoonMonitor');
  const status = await getStatus(gameServerId, config);
  const phase = phaseFor(status, config);
  const prev = await readVariable(gameServerId, mod.moduleId, BLOOD_STATE_KEY, null);
  if (phase.message && prev !== phase.key) await sendDiscord(channelId, phase.message);
  await writeVariable(gameServerId, mod.moduleId, BLOOD_STATE_KEY, phase.key);
}

await main();
