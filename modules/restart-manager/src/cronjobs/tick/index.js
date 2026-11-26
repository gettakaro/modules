import { data } from '@takaro/helpers';
import {
  MINUTE_MS,
  TICK_SLACK_MS,
  STALE_MS,
  getState,
  setState,
  getSetting,
  fill,
  humanDuration,
  warningList,
  broadcast,
  announceDiscord,
  sendWarning,
  getGameType,
  unsafeReason,
  executeRestart,
  compileSchedules,
  makeZoneReader,
  firstScheduledBetween,
} from './rm-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;
  const now = Date.now();

  const state = await getState(gameServerId, moduleId);
  const startPendingId = state.pending ? state.pending.id : null;
  const ctx = { prefix: await getSetting('commandPrefix', gameServerId, '/') };
  const warnings = warningList(config);
  const maxDelayMs = Math.max(0, Number(config.maxDelayMinutes) || 0) * MINUTE_MS;
  const resumeMinutes = Math.max(1, Math.round(Number(config.resumeCountdownMinutes) || 5));
  let gameType = null;
  const readGameType = async () => {
    if (gameType === null) gameType = await getGameType(gameServerId);
    return gameType;
  };

  // Writes the state, keeping a restart that a command set or cancelled while this tick ran.
  const save = async () => {
    const latest = await getState(gameServerId, moduleId);
    const latestPendingId = latest.pending ? latest.pending.id : null;
    const pending = latestPendingId !== startPendingId ? latest.pending : state.pending;
    await setState(gameServerId, moduleId, {
      ...state,
      pending,
      lastScheduledAt: [state.lastScheduledAt, latest.lastScheduledAt].filter(Boolean).sort().pop() || null,
      lastTickAt: new Date(now).toISOString(),
    });
  };

  const startCountdown = async (minutes) => {
    const pending = state.pending;
    pending.at = new Date(now + minutes * MINUTE_MS).toISOString();
    pending.warned = warnings.filter((w) => w >= minutes);
    pending.postponed = null;
  };

  // 1. Drop a countdown that is long overdue (Takaro or the game server was down).
  if (state.pending && !state.pending.postponed && now - new Date(state.pending.at).getTime() > STALE_MS) {
    console.log(`tick: dropping overdue restart planned for ${state.pending.at}`);
    state.pending = null;
  }

  // 2. Pick up a scheduled restart once it is within the first warning.
  if (!state.pending) {
    const compiled = compileSchedules(config);
    const lead = (warnings[0] || 0) * MINUTE_MS;
    const lastScheduled = state.lastScheduledAt ? new Date(state.lastScheduledAt).getTime() : 0;
    const from = Math.max(now - TICK_SLACK_MS, lastScheduled + 1);
    const at = firstScheduledBetween(compiled, makeZoneReader(config.timezone), from, now + lead + TICK_SLACK_MS);
    if (at !== null) {
      state.lastScheduledAt = new Date(at).toISOString();
      const lastRestart = state.lastRestartAt ? new Date(state.lastRestartAt).getTime() : 0;
      const minGap = Math.max(0, Number(config.minMinutesBetweenRestarts) || 0) * MINUTE_MS;
      if (lastRestart && at - lastRestart < minGap) {
        console.log(`tick: skipping the restart at ${state.lastScheduledAt}: the last restart was at ${state.lastRestartAt}`);
      } else {
        console.log(`tick: scheduled restart at ${state.lastScheduledAt}`);
        state.pending = {
          id: `schedule-${at}`,
          at: state.lastScheduledAt,
          originalAt: state.lastScheduledAt,
          source: 'schedule',
          by: null,
          warned: [],
          forced: false,
          postponed: null,
        };
      }
    }
  }

  const pending = state.pending;
  if (!pending) {
    await save();
    return;
  }
  const deadline = new Date(pending.originalAt).getTime() + maxDelayMs;

  // 3a. On hold: check again every few minutes, resume or force when the wait is over.
  if (pending.postponed) {
    const checkEvery = Math.max(1, Number(config.checkEveryMinutes) || 5) * MINUTE_MS;
    const lastCheck = new Date(pending.postponed.lastCheckAt).getTime();
    if (now - lastCheck >= checkEvery - TICK_SLACK_MS) {
      if (now >= deadline) {
        console.log(`tick: max delay reached (on hold for: ${pending.postponed.reason}), forcing the restart`);
        const reason = pending.postponed.reason;
        pending.forced = true;
        await startCountdown(resumeMinutes);
        const message = fill(config.forcedMessage, {
          reason,
          time: humanDuration(resumeMinutes * MINUTE_MS),
          prefix: ctx.prefix,
        });
        await broadcast(gameServerId, message);
        await announceDiscord(config, message);
      } else {
        const reason = await unsafeReason({ gameServerId, moduleId, config, gameType: await readGameType(), now });
        if (reason) {
          console.log(`tick: still on hold: ${reason}`);
          pending.postponed.lastCheckAt = new Date(now).toISOString();
          pending.postponed.reason = reason;
        } else {
          console.log('tick: safe again, resuming the countdown');
          await startCountdown(resumeMinutes);
          await sendWarning(gameServerId, config, resumeMinutes * MINUTE_MS, ctx, true);
        }
      }
    }
    await save();
    return;
  }

  // 3b. Countdown: warnings, then the restart.
  const remaining = new Date(pending.at).getTime() - now;
  const dueNow = remaining <= TICK_SLACK_MS;
  const dueWarnings = warnings.filter((w) => !pending.warned.includes(w) && remaining <= w * MINUTE_MS + TICK_SLACK_MS);
  if (!dueNow && dueWarnings.length === 0) {
    await save();
    return;
  }

  let forcedNow = false;
  if (!pending.forced && maxDelayMs > 0) {
    const reason = await unsafeReason({ gameServerId, moduleId, config, gameType: await readGameType(), now });
    if (reason && now < deadline) {
      console.log(`tick: putting the restart on hold: ${reason}`);
      pending.postponed = {
        since: new Date(now).toISOString(),
        reason,
        lastCheckAt: new Date(now).toISOString(),
      };
      const message = fill(config.postponedMessage, {
        reason,
        time: humanDuration(deadline - now),
        prefix: ctx.prefix,
      });
      await broadcast(gameServerId, message);
      await announceDiscord(config, message);
      await save();
      return;
    }
    if (reason) {
      console.log(`tick: not safe (${reason}) but the max delay is reached, restarting anyway`);
      pending.forced = true;
      forcedNow = true;
      const message = fill(config.forcedMessage, {
        reason,
        time: humanDuration(Math.max(remaining, MINUTE_MS)),
        prefix: ctx.prefix,
      });
      await broadcast(gameServerId, message);
      await announceDiscord(config, message);
    }
  }

  if (dueNow) {
    console.log(`tick: restarting now (${pending.source})`);
    state.pending = null;
    state.lastRestartAt = new Date(now).toISOString();
    await save();
    await executeRestart({ gameServerId, config, ctx });
    return;
  }

  const next = Math.min(...dueWarnings);
  if (!forcedNow) {
    await sendWarning(gameServerId, config, remaining, ctx, pending.warned.length === 0);
  }
  pending.warned = [...new Set([...pending.warned, ...warnings.filter((w) => w >= next)])];
  await save();
}

await main();
