import { data } from '@takaro/helpers';
import {
  MINUTE_MS,
  getState,
  humanDuration,
  compileSchedules,
  makeZoneReader,
  firstScheduledBetween,
} from './rm-helpers.js';

const LOOKAHEAD_MS = 8 * 24 * 60 * 60 * 1000;

async function main() {
  const { gameServerId, pog, module: mod } = data;
  const config = mod.userConfig;
  const now = Date.now();
  const state = await getState(gameServerId, mod.moduleId);
  const pending = state.pending;

  if (pending && pending.postponed) {
    const maxDelay = Math.max(0, Number(config.maxDelayMinutes) || 0) * MINUTE_MS;
    const resume = Math.max(1, Number(config.resumeCountdownMinutes) || 5) * MINUTE_MS;
    const latest = new Date(pending.originalAt).getTime() + maxDelay + resume - now;
    await pog.pm(
      `The server restart is on hold: ${pending.postponed.reason}. It runs when it is safe, at the latest in about ${humanDuration(latest)}.`,
    );
    return;
  }
  if (pending) {
    await pog.pm(`The server restarts in ${humanDuration(new Date(pending.at).getTime() - now)}.`);
    return;
  }

  const lastScheduled = state.lastScheduledAt ? new Date(state.lastScheduledAt).getTime() : 0;
  const next = firstScheduledBetween(
    compileSchedules(config),
    makeZoneReader(config.timezone),
    Math.max(now, lastScheduled + 1),
    now + LOOKAHEAD_MS,
  );
  if (next === null) {
    await pog.pm('No server restart is scheduled.');
    return;
  }
  await pog.pm(`Next server restart in ${humanDuration(next - now)}.`);
}

await main();
