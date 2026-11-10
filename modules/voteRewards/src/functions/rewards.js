import { takaro, data, TakaroUserError } from '@takaro/helpers';

// One variable per waiting vote, keyed by the Server List vote id, so a vote can only wait once.
export const PENDING_PREFIX = 'vote_pending_';

// Placeholder values reach a console command; anything outside this set could inject a second command.
const SAFE_VALUE = /^[A-Za-z0-9_:.-]+$/;

const SET_MISSING =
  'The vote reward item set no longer exists. Please ask your server administrator to reconfigure vote rewards.';

function config() {
  return data.module.userConfig;
}

function scope(playerId) {
  return { gameServerId: data.gameServerId, playerId, moduleId: data.module.moduleId };
}

async function setting(key) {
  return (await takaro.settings.settingsControllerGetOne(key, data.gameServerId)).data.data.value;
}

export function hasInGameReward() {
  const { itemSet, commands } = config();
  return Boolean(itemSet) || commands.length > 0;
}

/** Currency and role need no player in game, so they are granted at vote time. */
export async function grantImmediate(playerId) {
  const { currency, role, roleDurationHours } = config();
  if (currency > 0 && (await setting('economyEnabled')) === 'true') {
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(data.gameServerId, playerId, {
      currency,
    });
  }
  if (role) {
    const expiresAt =
      roleDurationHours > 0 ? new Date(Date.now() + roleDurationHours * 60 * 60 * 1000).toISOString() : undefined;
    if (heldAtLeastUntil(role, expiresAt)) {
      return;
    }
    await takaro.player.playerControllerAssignRole(playerId, role, {
      gameServerId: data.gameServerId,
      ...(expiresAt ? { expiresAt } : {}),
    });
  }
}

/** Assigning again overwrites the expiry, so a vote must never shorten a role the player already holds. */
function heldAtLeastUntil(roleId, expiresAt) {
  return (data.player.roleAssignments ?? []).some((assignment) => {
    if (assignment.roleId !== roleId) {
      return false;
    }
    if (assignment.gameServerId && assignment.gameServerId !== data.gameServerId) {
      return false;
    }
    if (!assignment.expiresAt) {
      return true;
    }
    return expiresAt !== undefined && new Date(assignment.expiresAt) >= new Date(expiresAt);
  });
}

/** Read before any claim is taken, so a missing set never consumes a waiting reward. */
export async function readItemSet() {
  const setId = config().itemSet;
  if (!setId) {
    return null;
  }
  let res;
  try {
    res = await takaro.itemSet.itemSetControllerGetOne(setId);
  } catch (error) {
    const status = error.response?.status;
    if (status === 404 || status === 400) {
      throw new TakaroUserError(SET_MISSING);
    }
    throw error;
  }
  const set = res.data.data;
  if (set.gameServerId !== data.gameServerId) {
    throw new TakaroUserError(SET_MISSING);
  }
  return set;
}

async function giveItems(set, playerId) {
  if (!set || set.lines.length === 0) {
    return [];
  }
  const lines = set.lines.map((line) => ({
    itemId: line.itemId,
    amount: line.amount,
    ...(line.quality ? { quality: line.quality } : {}),
  }));
  const res = await takaro.gameserver.gameServerControllerGiveItems(data.gameServerId, playerId, { lines });
  return res.data.data.lines;
}

/** Only `{gameId}` and `{steamId}`, never the player name: names are attacker-chosen. Null when a value is unsafe or missing. */
export function substitute(command, pog, player) {
  const values = { gameId: pog.gameId, steamId: player.steamId };
  let unsafe = false;
  const resolved = command.replace(/\{(gameId|steamId)\}/g, (_match, key) => {
    const value = values[key];
    if (typeof value !== 'string' || !SAFE_VALUE.test(value)) {
      unsafe = true;
      return '';
    }
    return value;
  });
  return unsafe ? null : resolved;
}

async function runCommands(pog, player) {
  for (const command of config().commands) {
    const resolved = substitute(command, pog, player);
    if (resolved === null) {
      console.log('Skipped a vote reward command: one of its placeholders has no safe value for this player.');
      continue;
    }
    await takaro.gameserver.gameServerControllerExecuteCommand(data.gameServerId, { command: resolved });
  }
}

function describe(lines) {
  return lines.map((line) => `${line.name ?? line.code} x${line.amount}`).join(', ');
}

export async function savePending(voteId, castAt, playerId, expiresAt) {
  const key = `${PENDING_PREFIX}${voteId}`;
  const existing = await takaro.variable.variableControllerSearch({
    filters: { key: [key], gameServerId: [data.gameServerId], playerId: [playerId], moduleId: [data.module.moduleId] },
  });
  if (existing.data.data.length > 0) {
    return;
  }
  await takaro.variable.variableControllerCreate({
    key,
    value: JSON.stringify({ voteId, castAt }),
    ...scope(playerId),
    expiresAt: expiresAt ?? new Date(Date.now() + config().pendingClaimDays * 24 * 60 * 60 * 1000).toISOString(),
  });
}

async function findPending(playerId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: { gameServerId: [data.gameServerId], playerId: [playerId], moduleId: [data.module.moduleId] },
    limit: 100,
  });
  return res.data.data.filter((variable) => variable.key.startsWith(PENDING_PREFIX));
}

/** Delete first: a run that loses the delete lost the claim to another run, so a reward is never delivered twice. */
async function take(variableId) {
  try {
    await takaro.variable.variableControllerDelete(variableId);
    return true;
  } catch (error) {
    if (/status code 404/.test(error.message)) {
      return false;
    }
    throw error;
  }
}

async function restore(claim, playerId) {
  const parsed = JSON.parse(claim.value);
  await savePending(parsed.voteId, parsed.castAt, playerId, claim.expiresAt);
}

/**
 * Gives the item set, then runs the commands. The claim goes back only while nothing reached the
 * player; once items are given a failing command stays failed, so the items are never given twice.
 */
async function deliverOrRestore(claim, set, pog, player) {
  let lines;
  try {
    lines = await giveItems(set, player.id);
  } catch (error) {
    await restore(claim, player.id);
    throw error;
  }
  const failed = lines.filter((line) => line.result === 'FAILED');
  if (lines.length > 0 && failed.length === lines.length) {
    await restore(claim, player.id);
    return false;
  }
  try {
    await runCommands(pog, player);
  } catch (error) {
    console.error(`Vote reward ${claim.key} was given, but a reward command failed and is not retried.`);
    throw error;
  }
  if (failed.length > 0) {
    await pog.pm(`Some vote reward items could not be given: ${describe(failed)}. Please contact a server administrator.`);
  }
  return true;
}

/** Delivers every waiting vote reward of this player; returns how many were waiting. */
export async function deliverPending(pog, player) {
  const pending = await findPending(player.id);
  if (pending.length === 0) {
    return 0;
  }
  const set = await readItemSet();
  let delivered = 0;
  for (const claim of pending) {
    if (!(await take(claim.id))) {
      continue;
    }
    if (!(await deliverOrRestore(claim, set, pog, player))) {
      const prefix = await setting('commandPrefix');
      await pog.pm(`Your vote reward could not be delivered. Use ${prefix}claimvote to try again later.`);
      break;
    }
    delivered += 1;
  }
  if (delivered > 0) {
    await pog.pm(config().thanksMessage);
  }
  return pending.length;
}
