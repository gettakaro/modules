import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import {
  MINUTE_MS,
  getState,
  isRunning,
  startEvent,
  endEvent,
  setState,
  getTextContext,
  fill,
  eventValues,
  broadcast,
  announceDiscord,
  formatDuration,
  formatMultiplier,
  bonusAmount,
  compileSchedules,
  makeZoneReader,
  nextScheduledStart,
} from './hh-helpers.js';

const MANAGE = 'HAPPY_HOUR_MANAGE';
const MAX_MULTIPLIER = 10;

function requireManage(pog, prefix) {
  if (!checkPermission(pog, MANAGE)) {
    throw new TakaroUserError(`Only admins can start or stop happy hour. Type ${prefix}happyhour to see the status.`);
  }
}

async function showStatus(gameServerId, moduleId, config, state, now, ctx) {
  if (isRunning(state, now)) {
    const parts = [
      `Happy hour is ON: ${formatMultiplier(state.multiplier)} for ${formatDuration(new Date(state.endsAt).getTime() - now)} more.`,
    ];
    const kill = bonusAmount(config.killBaseReward, state.multiplier, 0);
    const playtime = bonusAmount(config.playtimeBaseReward, state.multiplier, 0);
    if (kill > 0) parts.push(`+${kill} ${ctx.currency} per kill.`);
    if (playtime > 0) parts.push(`+${playtime} ${ctx.currency} every ${config.playtimeIntervalMinutes} min online.`);
    if ((config.doubleDropItems || []).length > 0 && config.doubleDropChance > 0) {
      parts.push(`${config.doubleDropChance}% bonus drop chance on kills.`);
    }
    await data.player.pm(parts.join(' '));
    return;
  }

  const next = nextScheduledStart(compileSchedules(config), makeZoneReader(config.timezone), now);
  if (next) {
    await data.player.pm(`No happy hour right now. Next one starts in ${formatDuration(next.at - now)}.`);
  } else {
    await data.player.pm('No happy hour right now, and none is scheduled.');
  }
}

async function main() {
  const { gameServerId, pog, player, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;
  const action = String(data.arguments.action || 'status').toLowerCase();
  const now = Date.now();
  const ctx = await getTextContext(gameServerId);
  const state = await getState(gameServerId, moduleId);

  if (action === 'status') {
    await showStatus(gameServerId, moduleId, config, state, now, ctx);
    return;
  }

  if (action === 'start') {
    requireManage(pog, ctx.prefix);
    const minutes = Number(data.arguments.minutes);
    const maxMinutes = Number(config.maxAdminMinutes) || 1440;
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > maxMinutes) {
      throw new TakaroUserError(`Usage: ${ctx.prefix}happyhour start <minutes 1-${maxMinutes}> [multiplier]`);
    }
    let multiplier = Number(data.arguments.multiplier);
    if (!multiplier) multiplier = config.multiplier;
    if (!Number.isFinite(multiplier) || multiplier <= 1 || multiplier > MAX_MULTIPLIER) {
      throw new TakaroUserError(`Multiplier must be more than 1 and at most ${MAX_MULTIPLIER} (e.g. 2 for double).`);
    }

    if (isRunning(state, now)) {
      // Running already: change it in place instead of announcing a second start.
      const updated = {
        ...state,
        endsAt: new Date(now + Math.round(minutes) * MINUTE_MS).toISOString(),
        multiplier,
        source: 'admin',
        startedBy: player.name,
      };
      await setState(gameServerId, moduleId, updated);
      const message = fill(config.updateMessage, eventValues(updated, now, ctx));
      await broadcast(gameServerId, message);
      await announceDiscord(config, message);
      await data.player.pm(`Happy hour updated: ${formatMultiplier(multiplier)} for ${Math.round(minutes)} min.`);
      return;
    }

    await startEvent({
      gameServerId,
      moduleId,
      config,
      durationMinutes: Math.round(minutes),
      multiplier,
      source: 'admin',
      startedBy: player.name,
      now,
    });
    await data.player.pm(`Happy hour started: ${formatMultiplier(multiplier)} for ${Math.round(minutes)} min.`);
    return;
  }

  if (action === 'stop') {
    requireManage(pog, ctx.prefix);
    if (!isRunning(state, now)) {
      throw new TakaroUserError('No happy hour is running.');
    }
    await endEvent({ gameServerId, moduleId, config, state, reason: `stopped by ${player.name}` });
    await data.player.pm('Happy hour stopped.');
    return;
  }

  throw new TakaroUserError(
    `Unknown option '${action}'. Use ${ctx.prefix}happyhour, ${ctx.prefix}happyhour start <minutes> [multiplier] or ${ctx.prefix}happyhour stop.`,
  );
}

await main();
