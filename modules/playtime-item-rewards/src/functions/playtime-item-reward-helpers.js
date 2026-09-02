import { takaro } from '@takaro/helpers';

const STATE_KEY = 'playtime_item_reward_state';
const DEFAULT_INTERVAL_MINUTES = 120;
const DEFAULT_REWARD_MESSAGE = '{playerName} received {items} after {intervalMinutes} minutes of playtime.';
const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

function trimOrEmpty(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function positiveInteger(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentage(value, fallback = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(0, parsed));
}

function getPlaytimeBucket(playtimeSeconds, intervalMinutes) {
  const seconds = Math.max(0, Number(playtimeSeconds) || 0);
  return Math.floor(seconds / (intervalMinutes * 60));
}

function randomIntegerInclusive(minimum, maximum) {
  if (maximum <= minimum) return minimum;
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function moduleIdFrom(mod) {
  return trimOrEmpty(mod?.moduleId || mod?.id);
}

function normalizeItems(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && item.enabled !== false)
    .map((item) => {
      const name = trimOrEmpty(item.name);
      if (!name) return null;
      return {
        name,
        amount: positiveInteger(item.amount, 1),
        quality: trimOrEmpty(item.quality),
        dropChance: percentage(item.dropChance),
      };
    })
    .filter(Boolean);
}

function normalizeSelectionMode(value, fallback = 'single') {
  return value === 'multiple' || value === 'single' ? value : fallback;
}

function normalizeMessageDelivery(value, fallback = 'broadcast') {
  return ['broadcast', 'private', 'both', 'off'].includes(value) ? value : fallback;
}

function defaultProfile(config) {
  const intervalMinimumMinutes = positiveInteger(config?.playtimeIntervalMinutes, DEFAULT_INTERVAL_MINUTES);
  const configuredMaximum = config?.playtimeIntervalMaximumMinutes === undefined
    ? intervalMinimumMinutes
    : positiveInteger(config.playtimeIntervalMaximumMinutes, intervalMinimumMinutes);
  return {
    profileName: 'default',
    intervalMinimumMinutes,
    intervalMaximumMinutes: Math.max(intervalMinimumMinutes, configuredMaximum),
    selectionMode: normalizeSelectionMode(config?.selectionMode),
    rewardMessage: trimOrEmpty(config?.rewardMessage) || DEFAULT_REWARD_MESSAGE,
    messageDelivery: normalizeMessageDelivery(config?.messageDelivery),
    items: normalizeItems(config?.items),
  };
}

function profileStateKey(profile) {
  return JSON.stringify([
    profile.profileName,
    profile.intervalMinimumMinutes,
    profile.intervalMaximumMinutes,
  ]);
}

function legacyProfileStateKey(profile) {
  return JSON.stringify([profile.profileName, profile.intervalMinimumMinutes]);
}

function activeRoleNames(assignments, gameServerId) {
  const now = Date.now();
  return new Set(
    (Array.isArray(assignments) ? assignments : [])
      .filter((assignment) => {
        if (assignment?.gameServerId && assignment.gameServerId !== gameServerId) return false;
        if (!assignment?.expiresAt) return true;
        const expiresAt = Date.parse(assignment.expiresAt);
        return !Number.isFinite(expiresAt) || expiresAt > now;
      })
      .map((assignment) => trimOrEmpty(assignment?.role?.name))
      .filter(Boolean),
  );
}

function resolveProfile(config, assignments, gameServerId) {
  const base = defaultProfile(config);
  const roleNames = activeRoleNames(assignments, gameServerId);
  const matches = (Array.isArray(config?.roleOverrides) ? config.roleOverrides : [])
    .map((override, index) => ({ override, index }))
    .filter(({ override }) => override && roleNames.has(trimOrEmpty(override.roleName)))
    .sort((left, right) => {
      const priorityDifference = Number(right.override.priority || 0) - Number(left.override.priority || 0);
      return priorityDifference || left.index - right.index;
    });

  if (matches.length === 0) return base;
  const override = matches[0].override;
  const intervalMinimumMinutes = override.playtimeIntervalMinutes === undefined
    ? base.intervalMinimumMinutes
    : positiveInteger(override.playtimeIntervalMinutes, base.intervalMinimumMinutes);
  let intervalMaximumMinutes;
  if (override.playtimeIntervalMaximumMinutes !== undefined) {
    intervalMaximumMinutes = positiveInteger(
      override.playtimeIntervalMaximumMinutes,
      intervalMinimumMinutes,
    );
  } else if (override.playtimeIntervalMinutes !== undefined) {
    intervalMaximumMinutes = intervalMinimumMinutes;
  } else {
    intervalMaximumMinutes = base.intervalMaximumMinutes;
  }
  return {
    profileName: trimOrEmpty(override.roleName) || base.profileName,
    intervalMinimumMinutes,
    intervalMaximumMinutes: Math.max(intervalMinimumMinutes, intervalMaximumMinutes),
    selectionMode: override.selectionMode === undefined
      ? base.selectionMode
      : normalizeSelectionMode(override.selectionMode, base.selectionMode),
    rewardMessage: override.rewardMessage === undefined
      ? base.rewardMessage
      : trimOrEmpty(override.rewardMessage),
    messageDelivery: override.messageDelivery === undefined
      ? base.messageDelivery
      : normalizeMessageDelivery(override.messageDelivery, base.messageDelivery),
    items: override.items === undefined ? base.items : normalizeItems(override.items),
  };
}

async function findStateVariable(gameServerId, moduleId, playerId) {
  const result = await takaro.variable.variableControllerSearch({
    filters: {
      key: [STATE_KEY],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
      playerId: [playerId],
    },
    limit: 1,
  });
  return result.data.data[0] || null;
}

function parseState(variable, playerId) {
  if (!variable) return { lastConsumedBucket: 0, claim: null };
  try {
    const parsed = JSON.parse(variable.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('state must be a JSON object');
    }
    if (
      parsed.consumedBuckets !== undefined
      && (!parsed.consumedBuckets || typeof parsed.consumedBuckets !== 'object' || Array.isArray(parsed.consumedBuckets))
    ) {
      throw new Error('consumedBuckets must be a JSON object');
    }
    if (
      parsed.schedules !== undefined
      && (!parsed.schedules || typeof parsed.schedules !== 'object' || Array.isArray(parsed.schedules))
    ) {
      throw new Error('schedules must be a JSON object');
    }
    for (const schedule of Object.values(parsed.schedules || {})) {
      if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
        throw new Error('each schedule must be a JSON object');
      }
      if (!Number.isInteger(schedule.intervalMinutes) || schedule.intervalMinutes < 1) {
        throw new Error('schedule intervalMinutes must be a positive integer');
      }
      if (!Number.isFinite(schedule.eligibleAtPlaytimeSeconds) || schedule.eligibleAtPlaytimeSeconds < 0) {
        throw new Error('schedule eligibleAtPlaytimeSeconds must be a non-negative number');
      }
    }
    return {
      ...parsed,
      lastConsumedBucket: Math.max(0, Math.floor(Number(parsed.lastConsumedBucket) || 0)),
      claim: parsed.claim || null,
    };
  } catch (err) {
    console.error(`playtime-item-rewards: invalid state for player ${playerId}: ${err}`);
    return null;
  }
}

function consumedBucketFor(state, profileKey) {
  if (state.consumedBuckets && Object.prototype.hasOwnProperty.call(state.consumedBuckets, profileKey)) {
    return Math.max(0, Math.floor(Number(state.consumedBuckets[profileKey]) || 0));
  }
  if (!state.lastProfileKey || state.lastProfileKey === profileKey) return state.lastConsumedBucket;
  return 0;
}

function createSchedule(profile, cycleStartPlaytimeSeconds) {
  const intervalMinutes = randomIntegerInclusive(
    profile.intervalMinimumMinutes,
    profile.intervalMaximumMinutes,
  );
  const cycleStart = Math.max(0, Number(cycleStartPlaytimeSeconds) || 0);
  return {
    intervalMinutes,
    eligibleAtPlaytimeSeconds: cycleStart + intervalMinutes * 60,
  };
}

function schedulesMatch(left, right) {
  return left?.intervalMinutes === right?.intervalMinutes
    && left?.eligibleAtPlaytimeSeconds === right?.eligibleAtPlaytimeSeconds;
}

async function readState(gameServerId, moduleId, playerId) {
  const variable = await findStateVariable(gameServerId, moduleId, playerId);
  return { variable, state: parseState(variable, playerId) };
}

async function writeState(gameServerId, moduleId, playerId, variable, state) {
  const value = JSON.stringify(state);
  if (variable) {
    await takaro.variable.variableControllerUpdate(variable.id, { value });
    return variable.id;
  }

  const created = await takaro.variable.variableControllerCreate({
    key: STATE_KEY,
    value,
    gameServerId,
    moduleId,
    playerId,
  });
  return created.data.data.id;
}

async function ensureSchedule(gameServerId, moduleId, playerId, profile) {
  const profileKey = profileStateKey(profile);
  const current = await readState(gameServerId, moduleId, playerId);
  if (!current.state) {
    throw new Error('persisted reward state is corrupt; refusing to schedule until it is repaired');
  }

  const existing = current.state.schedules?.[profileKey];
  if (existing) return { profileKey, schedule: existing };

  const legacyKey = legacyProfileStateKey(profile);
  const legacyBucket = consumedBucketFor(current.state, legacyKey);
  const cycleStartPlaytimeSeconds = legacyBucket * profile.intervalMinimumMinutes * 60;
  const schedule = createSchedule(profile, cycleStartPlaytimeSeconds);
  await writeState(gameServerId, moduleId, playerId, current.variable, {
    ...current.state,
    schedules: {
      ...(current.state.schedules || {}),
      [profileKey]: schedule,
    },
    updatedAt: new Date().toISOString(),
  });

  const confirmed = await readState(gameServerId, moduleId, playerId);
  const confirmedSchedule = confirmed.state?.schedules?.[profileKey];
  if (!confirmed.state || !confirmedSchedule) {
    throw new Error('could not persist reward schedule');
  }
  return { profileKey, schedule: confirmedSchedule };
}

function claimIsLive(claim) {
  if (!claim?.claimedAt) return false;
  if (claim.deliveryStartedAt) return true;
  const claimedAt = Date.parse(claim.claimedAt);
  return Number.isFinite(claimedAt) && Date.now() - claimedAt < CLAIM_TIMEOUT_MS;
}

async function acquireScheduleClaim(gameServerId, moduleId, playerId, profileKey, schedule, playtimeSeconds) {
  const current = await readState(gameServerId, moduleId, playerId);
  if (!current.state) {
    throw new Error('persisted reward state is corrupt; refusing to grant until it is repaired');
  }
  const currentSchedule = current.state.schedules?.[profileKey];
  if (!schedulesMatch(currentSchedule, schedule)) return null;
  if (playtimeSeconds < currentSchedule.eligibleAtPlaytimeSeconds) return null;
  if (current.state.claim && claimIsLive(current.state.claim)) return null;

  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const claim = {
    token,
    profileKey,
    intervalMinutes: currentSchedule.intervalMinutes,
    eligibleAtPlaytimeSeconds: currentSchedule.eligibleAtPlaytimeSeconds,
    claimedAt: new Date().toISOString(),
  };
  await writeState(gameServerId, moduleId, playerId, current.variable, {
    ...current.state,
    claim,
    updatedAt: new Date().toISOString(),
  });

  const confirmed = await readState(gameServerId, moduleId, playerId);
  return confirmed.state.claim?.token === token ? claim : null;
}

async function markDeliveryStarted(gameServerId, moduleId, playerId, claim) {
  const current = await readState(gameServerId, moduleId, playerId);
  if (!current.state || current.state.claim?.token !== claim.token) return null;

  const deliveryClaim = {
    ...current.state.claim,
    deliveryStartedAt: new Date().toISOString(),
  };
  await writeState(gameServerId, moduleId, playerId, current.variable, {
    ...current.state,
    claim: deliveryClaim,
    updatedAt: new Date().toISOString(),
  });

  const confirmed = await readState(gameServerId, moduleId, playerId);
  return confirmed.state?.claim?.token === claim.token
    && confirmed.state.claim.deliveryStartedAt === deliveryClaim.deliveryStartedAt
    ? deliveryClaim
    : null;
}

async function completeCycle(gameServerId, moduleId, playerId, claim, outcome, playtimeSeconds, profile) {
  const current = await readState(gameServerId, moduleId, playerId);
  if (!current.state) {
    console.error(`playtime-item-rewards: state became corrupt while completing player ${playerId}`);
    return false;
  }
  if (current.state.claim?.token !== claim.token) {
    console.error(`playtime-item-rewards: lost cycle claim for player ${playerId}`);
    return false;
  }
  const currentSchedule = current.state.schedules?.[claim.profileKey];
  if (!schedulesMatch(currentSchedule, claim)) {
    console.error(`playtime-item-rewards: reward schedule changed while completing player ${playerId}`);
    return false;
  }

  const legacyKey = legacyProfileStateKey(profile);
  const consumedBucket = getPlaytimeBucket(playtimeSeconds, profile.intervalMinimumMinutes);
  const nextSchedule = createSchedule(profile, playtimeSeconds);
  await writeState(gameServerId, moduleId, playerId, current.variable, {
    ...current.state,
    schedules: {
      ...(current.state.schedules || {}),
      [claim.profileKey]: nextSchedule,
    },
    consumedBuckets: {
      ...(current.state.consumedBuckets || {}),
      [legacyKey]: consumedBucket,
    },
    lastConsumedBucket: consumedBucket,
    lastProfileKey: legacyKey,
    claim: null,
    lastOutcome: outcome,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

async function releaseClaim(gameServerId, moduleId, playerId, claim, outcome) {
  const current = await readState(gameServerId, moduleId, playerId);
  if (!current.state) return false;
  if (current.state.claim?.token !== claim.token) return false;
  await writeState(gameServerId, moduleId, playerId, current.variable, {
    ...current.state,
    claim: null,
    lastOutcome: outcome,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

async function playerName(playerId, fallback) {
  try {
    const result = await takaro.player.playerControllerGetOne(playerId);
    return trimOrEmpty(result.data.data.name) || fallback;
  } catch (err) {
    console.error(`playtime-item-rewards: failed to fetch player ${playerId}: ${err}`);
    return fallback;
  }
}

async function findOnlinePlayers(gameServerId) {
  const players = [];
  const limit = 100;
  let page = 0;

  while (page < 100) {
    const result = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], online: [true] },
      limit,
      page,
    });
    const records = result.data.data;
    const hydrated = await Promise.all(records.map(async (record) => ({
      ...record,
      name: await playerName(record.playerId, trimOrEmpty(record.gameId) || record.playerId),
    })));
    players.push(...hydrated);
    if (records.length < limit) break;
    page++;
  }

  if (page >= 100) console.error('playtime-item-rewards: exceeded online-player pagination cap');
  return players;
}

function selectItems(profile) {
  const passing = profile.items.filter((item) => Math.random() * 100 < item.dropChance);
  if (profile.selectionMode === 'multiple') return passing;
  return passing.length > 0 ? [passing[Math.floor(Math.random() * passing.length)]] : [];
}

async function grantItems(gameServerId, player, items) {
  const granted = [];
  const failed = [];
  for (const item of items) {
    try {
      await takaro.gameserver.gameServerControllerGiveItem(gameServerId, player.playerId, {
        name: item.name,
        amount: item.amount,
        quality: item.quality,
      });
      granted.push(item);
    } catch (err) {
      failed.push(item);
      console.error(`playtime-item-rewards: failed to grant ${item.amount}x ${item.name} to ${player.name}: ${err}`);
    }
  }
  return { granted, failed };
}

function renderTemplate(template, placeholders) {
  return trimOrEmpty(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => (
    Object.prototype.hasOwnProperty.call(placeholders, key) ? String(placeholders[key]) : `{${key}}`
  ));
}

async function announceReward(gameServerId, player, profile, granted, intervalMinutes) {
  const delivery = normalizeMessageDelivery(profile.messageDelivery);
  if (delivery === 'off') return;
  if (!profile.rewardMessage) return;
  const itemSummary = granted.map((item) => `${item.amount}x ${item.name}`).join(', ');
  const message = renderTemplate(profile.rewardMessage, {
    playerName: player.name,
    playerId: player.playerId,
    gameId: player.gameId,
    items: itemSummary,
    itemCount: granted.reduce((sum, item) => sum + item.amount, 0),
    profileName: profile.profileName,
    intervalMinutes,
  });
  if (!message) return;

  if (delivery === 'broadcast' || delivery === 'both') {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message, opts: {} });
  }

  if ((delivery === 'private' || delivery === 'both') && trimOrEmpty(player.gameId)) {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message,
      opts: { recipient: { gameId: player.gameId } },
    });
  }

  console.log(`playtime-item-rewards: sent ${delivery} reward message "${message}"`);
}

export async function processPlaytimeItemRewards(gameServerId, mod) {
  const summary = {
    playersChecked: 0,
    playersEligible: 0,
    rewardsGranted: 0,
    noDrop: 0,
    failed: 0,
  };
  const moduleId = moduleIdFrom(mod);
  if (!moduleId) {
    console.error('playtime-item-rewards: module id is missing');
    summary.failed++;
    return summary;
  }

  const config = mod?.userConfig || {};
  const players = await findOnlinePlayers(gameServerId);
  summary.playersChecked = players.length;

  for (const player of players) {
    let claim = null;
    let itemGrantSucceeded = false;
    try {
      const profile = resolveProfile(config, player.roles, gameServerId);
      const playtimeSeconds = Math.max(0, Number(player.playtimeSeconds) || 0);
      const { profileKey, schedule } = await ensureSchedule(
        gameServerId,
        moduleId,
        player.playerId,
        profile,
      );
      if (playtimeSeconds < schedule.eligibleAtPlaytimeSeconds) continue;

      if (profile.items.length === 0) {
        console.error(`playtime-item-rewards: profile ${profile.profileName} has no valid items for player ${player.name}`);
        summary.failed++;
        continue;
      }

      claim = await acquireScheduleClaim(
        gameServerId,
        moduleId,
        player.playerId,
        profileKey,
        schedule,
        playtimeSeconds,
      );
      if (!claim) continue;
      summary.playersEligible++;

      const selected = selectItems(profile);
      if (selected.length === 0) {
        const completed = await completeCycle(
          gameServerId,
          moduleId,
          player.playerId,
          claim,
          'no-drop',
          playtimeSeconds,
          profile,
        );
        if (!completed) throw new Error('could not persist no-drop cycle completion');
        claim = null;
        summary.noDrop++;
        console.log(`playtime-item-rewards: no item chance passed for ${player.name} using profile ${profile.profileName}`);
        continue;
      }

      claim = await markDeliveryStarted(gameServerId, moduleId, player.playerId, claim);
      if (!claim) throw new Error('lost cycle claim before item delivery');

      const result = await grantItems(gameServerId, player, selected);
      if (result.granted.length === 0) {
        await releaseClaim(gameServerId, moduleId, player.playerId, claim, 'grant-failed');
        claim = null;
        summary.failed++;
        continue;
      }

      itemGrantSucceeded = true;
      let stateCompleted = false;
      try {
        stateCompleted = await completeCycle(
          gameServerId,
          moduleId,
          player.playerId,
          claim,
          'granted',
          playtimeSeconds,
          profile,
        );
      } catch (err) {
        console.error(`playtime-item-rewards: items granted but cycle completion failed for ${player.name}: ${err}`);
      }
      if (!stateCompleted) {
        summary.failed++;
        console.error(
          `playtime-item-rewards: retaining claim after successful grant to ${player.name}; manual state repair may be required`,
        );
      } else {
        claim = null;
      }
      summary.rewardsGranted += result.granted.length;
      if (result.failed.length > 0) summary.failed += result.failed.length;
      console.log(
        `playtime-item-rewards: granted ${result.granted.map((item) => `${item.amount}x ${item.name}`).join(', ')} to ${player.name} using profile ${profile.profileName}`,
      );

      try {
        await announceReward(gameServerId, player, profile, result.granted, claim?.intervalMinutes || schedule.intervalMinutes);
      } catch (err) {
        console.error(`playtime-item-rewards: items granted but announcement failed for ${player.name}: ${err}`);
      }
    } catch (err) {
      summary.failed++;
      console.error(`playtime-item-rewards: failed to process player ${player.playerId}: ${err}`);
      if (claim && !itemGrantSucceeded) {
        try {
          await releaseClaim(gameServerId, moduleId, player.playerId, claim, 'processing-failed');
        } catch (releaseErr) {
          console.error(`playtime-item-rewards: failed to release claim for player ${player.playerId}: ${releaseErr}`);
        }
      } else if (claim) {
        console.error(
          `playtime-item-rewards: claim retained for player ${player.playerId} because an item was already delivered`,
        );
      }
    }
  }

  if (summary.playersEligible === 0) {
    console.log('playtime-item-rewards: no players reached a new playtime interval');
  }
  console.log(
    `playtime-item-rewards: checked ${summary.playersChecked}, eligible ${summary.playersEligible}, granted ${summary.rewardsGranted}, no-drop ${summary.noDrop}, failed ${summary.failed}`,
  );
  return summary;
}
