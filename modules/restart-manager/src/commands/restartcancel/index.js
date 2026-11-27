import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import {
  MANAGE_PERMISSION,
  getState,
  setState,
  getSetting,
  fill,
  humanDuration,
  broadcast,
  announceDiscord,
  compileSchedules,
  makeZoneReader,
  firstScheduledBetween,
} from './rm-helpers.js';

const LOOKAHEAD_MS = 8 * 24 * 60 * 60 * 1000;

async function main() {
  const { gameServerId, pog, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;
  const prefix = await getSetting('commandPrefix', gameServerId, '/');

  if (!checkPermission(pog, MANAGE_PERMISSION)) {
    throw new TakaroUserError(`Only admins can cancel a restart. Type ${prefix}restartstatus to see when the next restart is.`);
  }

  const now = Date.now();
  const state = await getState(gameServerId, moduleId);

  if (state.pending) {
    const announced =
      Boolean(state.pending.announced) || (state.pending.warned || []).length > 0 || Boolean(state.pending.postponed);
    state.pending = null;
    await setState(gameServerId, moduleId, state);
    if (announced) {
      const message = fill(config.cancelMessage, { prefix });
      await broadcast(gameServerId, message);
      await announceDiscord(config, message);
    }
    await pog.pm('Restart cancelled.');
    return;
  }

  // Nothing counting down yet: skip the next scheduled restart instead.
  const lastScheduled = state.lastScheduledAt ? new Date(state.lastScheduledAt).getTime() : 0;
  const next = firstScheduledBetween(
    compileSchedules(config),
    makeZoneReader(config.timezone),
    Math.max(now, lastScheduled + 1),
    now + LOOKAHEAD_MS,
  );
  if (next === null) {
    throw new TakaroUserError('No restart is planned, so there is nothing to cancel.');
  }
  state.lastScheduledAt = new Date(next).toISOString();
  await setState(gameServerId, moduleId, state);
  await pog.pm(`Skipped the next scheduled restart (it was due in ${humanDuration(next - now)}).`);
}

await main();
