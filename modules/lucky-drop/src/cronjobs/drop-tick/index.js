import { data } from '@takaro/helpers';
import {
  KEYS,
  getVariable,
  getOnlinePogs,
  getSessionStarts,
  ensureSessions,
  trackPositions,
  closeExpiredRace,
  scheduleNext,
  runDrop,
} from './lucky-drop-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const moduleId = mod.moduleId;
  const config = mod.userConfig;
  const nowMs = Date.now();

  // A running claim race blocks new drops; an expired one is closed here.
  const raceRunning = await closeExpiredRace(gameServerId, moduleId, config, nowMs);

  const pogs = await getOnlinePogs(gameServerId);
  // Track positions every tick, so "AFK" means "did not move since the previous tick".
  const afk = config.excludeAfk ? await trackPositions(gameServerId, moduleId, pogs) : new Set();
  const starts = await getSessionStarts(gameServerId, moduleId);
  await ensureSessions(gameServerId, moduleId, pogs, starts, nowMs);

  if (raceRunning) {
    console.log('luckyDrop: claim race still running, skipping');
    return;
  }

  const nextAt = await getVariable(gameServerId, moduleId, KEYS.nextAt);
  if (!nextAt) {
    const at = await scheduleNext(gameServerId, moduleId, config, nowMs);
    console.log(`luckyDrop: first run, next drop scheduled at ${new Date(at).toISOString()}`);
    return;
  }
  if (new Date(nextAt).getTime() > nowMs) {
    console.log(`luckyDrop: next drop at ${nextAt}, not due yet`);
    return;
  }

  // Not enough players: keep the due time, so the drop fires as soon as enough players are online.
  if (pogs.length < config.minOnlinePlayers) {
    console.log(`luckyDrop: ${pogs.length} online, need ${config.minOnlinePlayers}, waiting`);
    return;
  }

  const status = await runDrop({ gameServerId, moduleId, config, nowMs, pogs, afk, starts });
  const at = await scheduleNext(gameServerId, moduleId, config, nowMs);
  console.log(`luckyDrop: ${status}; next drop at ${new Date(at).toISOString()}`);
}

await main();
