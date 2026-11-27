import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import {
  MINUTE_MS,
  MANAGE_PERMISSION,
  getState,
  setState,
  getSetting,
  warningList,
  sendWarning,
  executeRestart,
} from './rm-helpers.js';

async function main() {
  const { gameServerId, pog, player, arguments: args, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;
  const prefix = await getSetting('commandPrefix', gameServerId, '/');

  if (!checkPermission(pog, MANAGE_PERMISSION)) {
    throw new TakaroUserError(`Only admins can restart the server. Type ${prefix}restartstatus to see when the next restart is.`);
  }

  const minutes = Number(args.minutes);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
    throw new TakaroUserError(`Usage: ${prefix}restartnow <minutes 0-1440>. 0 restarts right away.`);
  }

  const now = Date.now();
  const state = await getState(gameServerId, moduleId);
  const ctx = { prefix };

  if (minutes === 0) {
    state.pending = null;
    state.lastRestartAt = new Date(now).toISOString();
    await setState(gameServerId, moduleId, state);
    await pog.pm('Restarting the server now.');
    await executeRestart({ gameServerId, config, ctx });
    return;
  }

  const replaced = Boolean(state.pending);
  const at = new Date(now + minutes * MINUTE_MS).toISOString();
  state.pending = {
    id: `admin-${now}`,
    at,
    originalAt: at,
    source: 'admin',
    by: player ? player.name : null,
    warned: warningList(config).filter((w) => w >= minutes),
    // An admin restart skips the safe-window checks: the admin decided.
    forced: true,
    postponed: null,
    // Players hear about it right away, so a cancel must be announced too.
    announced: true,
  };
  await setState(gameServerId, moduleId, state);
  await sendWarning(gameServerId, config, minutes * MINUTE_MS, ctx, true);
  await pog.pm(
    `${replaced ? 'Restart moved' : 'Restart set'}: in ${minutes} min. Type ${prefix}restartcancel to stop it.`,
  );
}

await main();
