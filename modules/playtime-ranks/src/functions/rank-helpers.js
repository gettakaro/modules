import { takaro } from '@takaro/helpers';

export const STATE_KEY = 'playtime_rank_state';

/** Valid ranks from the config, sorted by hours needed (lowest first). */
export function getLadder(config) {
  const raw = Array.isArray(config.ranks) ? config.ranks : [];
  return raw
    .filter((r) => r && typeof r.name === 'string' && r.name.trim() && Number.isFinite(Number(r.hours)) && Number(r.hours) >= 0)
    .map((r) => ({
      name: r.name.trim(),
      hours: Number(r.hours),
      roleId: typeof r.roleId === 'string' && r.roleId.trim() ? r.roleId.trim() : null,
      reward: Number.isFinite(Number(r.reward)) && Number(r.reward) > 0 ? Math.floor(Number(r.reward)) : 0,
      message: typeof r.message === 'string' ? r.message : '',
    }))
    .sort((a, b) => a.hours - b.hours);
}

/** Index of the highest rank the hours qualify for, or -1. */
export function rankIndexFor(ladder, hours) {
  let idx = -1;
  for (let i = 0; i < ladder.length; i++) {
    if (hours >= ladder[i].hours) idx = i;
  }
  return idx;
}

export function formatHours(hours) {
  const rounded = Math.floor(hours * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatDuration(hours) {
  const totalMinutes = Math.max(1, Math.ceil(hours * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function fill(template, vars) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

export async function getSetting(gameServerId, key, fallback) {
  try {
    const res = await takaro.settings.settingsControllerGetOne(key, gameServerId);
    const value = res.data.data.value;
    return value === undefined || value === null ? fallback : value;
  } catch (err) {
    console.warn(`playtime-ranks: could not read setting ${key}: ${err}`);
    return fallback;
  }
}

export async function sendPm(gameServerId, gameId, message) {
  if (!message) return;
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message,
    opts: { recipient: { gameId } },
  });
}

export async function broadcast(gameServerId, message) {
  if (!message) return;
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message });
}

async function findState(gameServerId, moduleId, playerId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: { key: [STATE_KEY], gameServerId: [gameServerId], moduleId: [moduleId], playerId: [playerId] },
  });
  return res.data.data.length > 0 ? res.data.data[0] : null;
}

export async function readState(gameServerId, moduleId, playerId) {
  const row = await findState(gameServerId, moduleId, playerId);
  if (!row) return { row: null, state: null };
  try {
    const parsed = JSON.parse(row.value);
    return {
      row,
      state: {
        rank: typeof parsed.rank === 'string' ? parsed.rank : null,
        rewarded: Array.isArray(parsed.rewarded) ? parsed.rewarded.filter((n) => typeof n === 'string') : [],
      },
    };
  } catch (err) {
    console.error(`playtime-ranks: corrupt state for player ${playerId}, starting fresh: ${err}`);
    return { row, state: null };
  }
}

async function writeState(gameServerId, moduleId, playerId, row, state) {
  const value = JSON.stringify({ ...state, updatedAt: new Date().toISOString() });
  if (row) {
    await takaro.variable.variableControllerUpdate(row.id, { value });
  } else {
    await takaro.variable.variableControllerCreate({ key: STATE_KEY, value, gameServerId, moduleId, playerId });
  }
}

/**
 * Shared, lazily-loaded per-run context (settings, player names), so a cron run over many
 * players reads each setting once.
 */
export function createContext(gameServerId) {
  const cache = {};
  const names = new Map();
  const once = (key, fallback) => {
    if (!(key in cache)) cache[key] = getSetting(gameServerId, key, fallback);
    return cache[key];
  };
  return {
    gameServerId,
    prefix: () => once('commandPrefix', '/'),
    currencyName: () => once('currencyName', 'coins'),
    economyEnabled: async () => String(await once('economyEnabled', 'false')) === 'true',
    async player(playerId) {
      if (!names.has(playerId)) {
        names.set(playerId, takaro.player.playerControllerGetOne(playerId).then((r) => r.data.data));
      }
      return names.get(playerId);
    },
  };
}

export async function getPlaytimeHours(ctx, pog, config) {
  if (config.playtimeSource === 'global') {
    const player = await ctx.player(pog.playerId);
    return (Number(player.playtimeSeconds) || 0) / 3600;
  }
  return (Number(pog.playtimeSeconds) || 0) / 3600;
}

/**
 * Brings one player in line with the rank ladder: gives the earned rank role, removes lower rank
 * roles (when configured), pays one-time rewards and announces a promotion.
 * `pog` must be a fresh player-on-gameserver record (with `roles` and `playtimeSeconds`).
 */
export async function evaluatePlayer({ ctx, moduleId, config, pog, announce = true }) {
  const { gameServerId } = ctx;
  const ladder = getLadder(config);
  const hours = await getPlaytimeHours(ctx, pog, config);
  const earnedIdx = rankIndexFor(ladder, hours);
  const result = {
    hours,
    ladder,
    rankIndex: earnedIdx,
    rank: earnedIdx >= 0 ? ladder[earnedIdx] : null,
    next: earnedIdx + 1 < ladder.length ? ladder[earnedIdx + 1] : null,
    promoted: false,
    rolesAdded: [],
    rolesRemoved: [],
    rewardsPaid: 0,
    errors: [],
  };
  if (earnedIdx < 0) return result;

  const rank = ladder[earnedIdx];
  const held = Array.isArray(pog.roles) ? pog.roles : [];

  if (rank.roleId && !held.some((a) => a.roleId === rank.roleId)) {
    try {
      const body = config.roleScope === 'global' ? {} : { gameServerId };
      await takaro.player.playerControllerAssignRole(pog.playerId, rank.roleId, body);
      result.rolesAdded.push(rank.name);
    } catch (err) {
      console.error(`playtime-ranks: failed to assign role ${rank.roleId} (${rank.name}) to ${pog.playerId}: ${err}`);
      result.errors.push(`could not assign role for ${rank.name}`);
    }
  }

  if (config.removePreviousRoles !== false) {
    for (let i = 0; i < earnedIdx; i++) {
      const lower = ladder[i];
      if (!lower.roleId || lower.roleId === rank.roleId) continue;
      for (const assignment of held.filter((a) => a.roleId === lower.roleId)) {
        try {
          const body = assignment.gameServerId ? { gameServerId: assignment.gameServerId } : undefined;
          await takaro.player.playerControllerRemoveRole(pog.playerId, lower.roleId, body);
          result.rolesRemoved.push(lower.name);
        } catch (err) {
          console.error(`playtime-ranks: failed to remove role ${lower.roleId} (${lower.name}) from ${pog.playerId}: ${err}`);
          result.errors.push(`could not remove role for ${lower.name}`);
        }
      }
    }
  }

  const { row, state } = await readState(gameServerId, moduleId, pog.playerId);
  const rewarded = state ? [...state.rewarded] : [];
  const prevIdx = state && state.rank ? ladder.findIndex((r) => r.name === state.rank) : -1;
  result.promoted = earnedIdx > prevIdx && rank.hours > 0;

  const paid = [];
  const due = ladder.slice(0, earnedIdx + 1).filter((r) => r.reward > 0 && !rewarded.includes(r.name));
  if (due.length > 0) {
    if (await ctx.economyEnabled()) {
      for (const r of due) {
        try {
          await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, pog.playerId, {
            currency: r.reward,
          });
          rewarded.push(r.name);
          paid.push(r);
          result.rewardsPaid += r.reward;
        } catch (err) {
          console.error(`playtime-ranks: failed to pay ${r.reward} for ${r.name} to ${pog.playerId}: ${err}`);
          result.errors.push(`could not pay reward for ${r.name}`);
        }
      }
    } else {
      console.warn('playtime-ranks: economy is disabled, rank rewards are kept for later');
    }
  }

  const stateChanged = !state || state.rank !== rank.name || paid.length > 0;
  if (stateChanged) {
    await writeState(gameServerId, moduleId, pog.playerId, row, { rank: rank.name, rewarded });
  }

  if (announce && (result.promoted || paid.length > 0)) {
    const player = await ctx.player(pog.playerId);
    const vars = {
      player: player.name,
      rank: rank.name,
      hours: formatHours(hours),
      reward: result.rewardsPaid,
      currency: await ctx.currencyName(),
      prefix: await ctx.prefix(),
    };
    try {
      if (result.promoted) {
        await sendPm(gameServerId, pog.gameId, fill(rank.message || config.promotionMessage, vars));
      }
      if (paid.length > 0 && config.rewardMessage) {
        await sendPm(gameServerId, pog.gameId, fill(config.rewardMessage, vars));
      }
      if (result.promoted && config.broadcastMessage) {
        await broadcast(gameServerId, fill(config.broadcastMessage, vars));
      }
    } catch (err) {
      console.error(`playtime-ranks: failed to send promotion messages for ${pog.playerId}: ${err}`);
    }
  }

  return result;
}

/** One-line status, e.g. "Rank: Regular (12.5 h played). Next: Veteran in 37h 30m." */
export function describeStatus(result, subject = 'You') {
  const { hours, rank, next } = result;
  const own = subject === 'You';
  const played = `${formatHours(hours)} h played`;
  if (result.ladder.length === 0) return 'No playtime ranks are configured on this server.';
  const current = rank ? `Rank: ${rank.name} (${played}).` : `${own ? 'You have' : `${subject} has`} no rank yet (${played}).`;
  if (!next) return `${current} ${own ? 'You have' : `${subject} has`} reached the highest rank!`;
  return `${current} Next: ${next.name} in ${formatDuration(next.hours - hours)}.`;
}
