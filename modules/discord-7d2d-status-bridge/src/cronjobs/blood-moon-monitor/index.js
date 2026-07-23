import { data } from '@takaro/helpers';
import {
  acquireBloodMonitorLock,
  BLOOD_DELIVERED_KEY,
  BLOOD_PENDING_KEY,
  BLOOD_STATE_KEY,
  getCurrentModuleInstallation,
  getDiscordChannelFromHook,
  getTimeStatus,
  isBloodMoonDay,
  readVariable,
  releaseBloodMonitorLock,
  renewBloodMonitorLock,
  resolveMessage,
  sendDiscord,
  writeVariable,
} from './discord-7d2d-status-helpers.js';

const MAX_ANNOUNCEMENT_KEYS = 32;
const MESSAGE_KEY_BY_PREFIX = {
  today: 'bloodMoonTodayMessage',
  start: 'bloodMoonStartingMessage',
  end: 'bloodMoonEndingMessage',
};

function stateFor(status, config) {
  const parsed = status.parsed;
  if (!parsed) return { observedKey: 'unknown', announcements: [] };
  const first = config.firstHordeDay ?? 7;
  const interval = config.hordeIntervalDays ?? 7;
  const start = config.bloodMoonStartHour ?? 22;
  const end = config.bloodMoonEndHour ?? 4;
  const currentIsHorde = isBloodMoonDay(parsed.day, first, interval);
  const previousDay = parsed.day - 1;
  const previousIsHorde = parsed.day > 1 && isBloodMoonDay(previousDay, first, interval);

  if (currentIsHorde && parsed.hour !== null && parsed.hour >= start) {
    const key = `start:${parsed.day}`;
    return { observedKey: key, announcements: [key] };
  }
  if (previousIsHorde && parsed.hour !== null && parsed.hour < end) {
    return { observedKey: `start:${previousDay}`, announcements: [] };
  }

  const announcements = [];
  if (previousIsHorde && parsed.hour !== null && parsed.hour >= end) {
    announcements.push(`end:${previousDay}`);
  }
  if (currentIsHorde) {
    const key = `today:${parsed.day}`;
    announcements.push(key);
    return { observedKey: key, announcements };
  }
  if (previousIsHorde && parsed.hour !== null && parsed.hour >= end) {
    return { observedKey: `end:${previousDay}`, announcements };
  }
  return { observedKey: `normal:${parsed.day}`, announcements };
}

function isAnnouncementKey(value) {
  return typeof value === 'string' && /^(?:today|start|end):\d+$/.test(value);
}

function normalizeAnnouncementKeys(value) {
  if (!Array.isArray(value)) return [];
  const unique = [];
  for (const key of value) {
    if (!isAnnouncementKey(key) || unique.includes(key)) continue;
    unique.push(key);
  }
  return unique.slice(-MAX_ANNOUNCEMENT_KEYS);
}

function sameHistory(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((key, index) => key === right[index]);
}

function addAnnouncementKey(history, key) {
  return normalizeAnnouncementKeys([...history, key]);
}

function messageKeyFor(announcementKey) {
  if (!isAnnouncementKey(announcementKey)) return null;
  return MESSAGE_KEY_BY_PREFIX[announcementKey.split(':', 1)[0]] ?? null;
}

async function main() {
  const { gameServerId, module: mod } = data;
  const lockOwner = await acquireBloodMonitorLock(gameServerId, mod.moduleId);

  try {
    const installation = await getCurrentModuleInstallation(gameServerId, mod.moduleId);
    await renewBloodMonitorLock(gameServerId, mod.moduleId, lockOwner);
    if (!installation) {
      console.log('discord-7d2d-status: module installation no longer exists, skipped Blood Moon monitor');
      return;
    }
    const config = installation.userConfig ?? {};
    const currentData = {
      ...data,
      module: {
        ...mod,
        userConfig: config,
        systemConfig: installation.systemConfig ?? {},
      },
    };
    const channelId = getDiscordChannelFromHook(currentData, config.monitoringChannelId, 'bloodMoonMonitor');
    const status = await getTimeStatus(gameServerId, config);
    await renewBloodMonitorLock(gameServerId, mod.moduleId, lockOwner);
    const state = stateFor(status, config);
    const previousObserved = await readVariable(gameServerId, mod.moduleId, BLOOD_STATE_KEY, null);
    const storedDelivered = await readVariable(gameServerId, mod.moduleId, BLOOD_DELIVERED_KEY, null);
    const storedPending = await readVariable(gameServerId, mod.moduleId, BLOOD_PENDING_KEY, null);
    await renewBloodMonitorLock(gameServerId, mod.moduleId, lockOwner);

    if (previousObserved !== state.observedKey) {
      await renewBloodMonitorLock(gameServerId, mod.moduleId, lockOwner);
      await writeVariable(gameServerId, mod.moduleId, BLOOD_STATE_KEY, state.observedKey);
    }

    let delivered = normalizeAnnouncementKeys(storedDelivered);
    if (storedDelivered === null && isAnnouncementKey(previousObserved)) {
      delivered = addAnnouncementKey(delivered, previousObserved);
    }
    if (!sameHistory(storedDelivered, delivered)) {
      await renewBloodMonitorLock(gameServerId, mod.moduleId, lockOwner);
      await writeVariable(gameServerId, mod.moduleId, BLOOD_DELIVERED_KEY, delivered);
    }

    let pending = normalizeAnnouncementKeys(storedPending)
      .filter((key) => !delivered.includes(key));
    for (const newlyDue of state.announcements) {
      if (delivered.includes(newlyDue)) continue;
      pending = addAnnouncementKey(pending, newlyDue);
    }
    if (!sameHistory(storedPending, pending)) {
      await renewBloodMonitorLock(gameServerId, mod.moduleId, lockOwner);
      await writeVariable(gameServerId, mod.moduleId, BLOOD_PENDING_KEY, pending);
    }

    for (const pendingKey of [...pending]) {
      const messageKey = messageKeyFor(pendingKey);
      if (!messageKey) continue;
      await renewBloodMonitorLock(gameServerId, mod.moduleId, lockOwner);
      const result = await sendDiscord(channelId, resolveMessage(config, messageKey));
      if (result === null) continue;
      delivered = addAnnouncementKey(delivered, pendingKey);
      await renewBloodMonitorLock(gameServerId, mod.moduleId, lockOwner);
      await writeVariable(gameServerId, mod.moduleId, BLOOD_DELIVERED_KEY, delivered);
      pending = pending.filter((key) => key !== pendingKey);
      await renewBloodMonitorLock(gameServerId, mod.moduleId, lockOwner);
      await writeVariable(gameServerId, mod.moduleId, BLOOD_PENDING_KEY, pending);
    }
  } finally {
    await releaseBloodMonitorLock(gameServerId, mod.moduleId, lockOwner);
  }
}

await main();
