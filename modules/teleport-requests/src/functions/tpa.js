import { takaro, data, checkPermission, TakaroUserError } from '@takaro/helpers';

export const USE_PERMISSION = 'TPA_USE';
export const BYPASS_COOLDOWN_PERMISSION = 'TPA_BYPASS_COOLDOWN';

const REQUEST_PREFIX = 'tpa_req_';
const COOLDOWN_KEY = 'tpa_cooldown';
const BLOCKS_KEY = 'tpa_blocks';
// A player-argument default that no real name can collide with: "pick the oldest request".
export const ANY_PLAYER = '*';

/** One request row: key names the target, playerId is the requester, so each pair has one row. */
const requestKey = (targetId) => `${REQUEST_PREFIX}${targetId}`;

function scope() {
  return { gameServerId: data.gameServerId, moduleId: data.module.moduleId };
}

export function requireUse() {
  if (!checkPermission(data.pog, USE_PERMISSION)) {
    throw new TakaroUserError('You do not have permission to send teleport requests.');
  }
}

export function formatDuration(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds <= 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export async function prefix() {
  const res = await takaro.settings.settingsControllerGetOne('commandPrefix', data.gameServerId);
  return res.data.data.value;
}

export async function playerName(playerId) {
  try {
    return (await takaro.player.playerControllerGetOne(playerId)).data.data.name;
  } catch {
    return 'Someone';
  }
}

export async function freshPog(playerId) {
  return (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(data.gameServerId, playerId)).data.data;
}

/** Private message to any player. Without a recipient Takaro would broadcast, so the gameId is required. */
export async function tell(gameId, message) {
  await takaro.gameserver.gameServerControllerSendMessage(data.gameServerId, {
    message,
    opts: { recipient: { gameId } },
  });
}

function parseRequest(row) {
  try {
    return { row, ...JSON.parse(row.value) };
  } catch {
    console.log(`Request ${row.key} holds unreadable JSON, ignoring it`);
    return null;
  }
}

function isLive(request, now) {
  return request && new Date(request.expiresAt).getTime() > now.getTime();
}

/** The requests other players sent to `targetId`, oldest first. Expired rows are hidden by Takaro. */
export async function incomingRequests(targetId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: { key: [requestKey(targetId)], ...wrap(scope()) },
    limit: 100,
  });
  const now = new Date();
  return res.data.data
    .map(parseRequest)
    .filter((request) => isLive(request, now))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/** The one request `requesterId` has open, if any. */
export async function outgoingRequest(requesterId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: { playerId: [requesterId], ...wrap(scope()) },
    search: { key: [REQUEST_PREFIX] },
    limit: 100,
  });
  const now = new Date();
  return (
    res.data.data
      .filter((row) => row.key.startsWith(REQUEST_PREFIX))
      .map(parseRequest)
      .find((request) => isLive(request, now)) ?? null
  );
}

function wrap(values) {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, [v]]));
}

export async function createRequest(request) {
  await takaro.variable.variableControllerCreate({
    key: requestKey(request.targetId),
    value: JSON.stringify(request),
    playerId: request.requesterId,
    expiresAt: request.expiresAt,
    ...scope(),
  });
}

export async function deleteRequest(request) {
  try {
    await takaro.variable.variableControllerDelete(request.row.id);
  } catch (error) {
    // Already gone (expired or a double accept); the caller treats it as consumed.
    console.log(`Request ${request.row.key} was already removed: ${error?.message ?? error}`);
  }
}

/**
 * Picks one of `requests` by requester name: exact match first, then a unique name prefix.
 * `ANY_PLAYER` picks the oldest.
 */
export function pickRequest(requests, wanted) {
  if (!wanted || wanted === ANY_PLAYER) {
    return requests[0];
  }
  const needle = wanted.toLowerCase();
  const exact = requests.find((r) => r.requesterName.toLowerCase() === needle);
  if (exact) {
    return exact;
  }
  const partial = requests.filter((r) => r.requesterName.toLowerCase().startsWith(needle));
  if (partial.length === 1) {
    return partial[0];
  }
  if (partial.length > 1) {
    throw new TakaroUserError(
      `Several requests match "${wanted}": ${partial.map((r) => r.requesterName).join(', ')}. Type more of the name.`,
    );
  }
  throw new TakaroUserError(`You have no teleport request from "${wanted}".`);
}

async function findPlayerVariable(key, playerId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: { key: [key], playerId: [playerId], ...wrap(scope()) },
  });
  return res.data.data[0];
}

/** Milliseconds left on `playerId`'s cooldown, 0 when none. */
export async function cooldownLeft(playerId) {
  const row = await findPlayerVariable(COOLDOWN_KEY, playerId);
  if (!row?.expiresAt) {
    return 0;
  }
  return Math.max(0, new Date(row.expiresAt).getTime() - Date.now());
}

export async function startCooldown(playerId, ms) {
  if (!(ms > 0)) {
    return;
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ms).toISOString();
  const value = JSON.stringify({ usedAt: now.toISOString() });
  const existing = await findPlayerVariable(COOLDOWN_KEY, playerId);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value, expiresAt });
    return;
  }
  await takaro.variable.variableControllerCreate({ key: COOLDOWN_KEY, value, playerId, expiresAt, ...scope() });
}

/** The players `playerId` blocked, as `[{ id, name }]`. */
export async function readBlocks(playerId) {
  const row = await findPlayerVariable(BLOCKS_KEY, playerId);
  if (!row) {
    return { row: null, list: [] };
  }
  try {
    const list = JSON.parse(row.value);
    return { row, list: Array.isArray(list) ? list : [] };
  } catch {
    return { row, list: [] };
  }
}

export async function writeBlocks(playerId, row, list) {
  const value = JSON.stringify(list);
  if (row) {
    await takaro.variable.variableControllerUpdate(row.id, { value });
    return;
  }
  await takaro.variable.variableControllerCreate({ key: BLOCKS_KEY, value, playerId, ...scope() });
}

function positionOf(pog) {
  if (pog.positionX === undefined || pog.positionX === null) {
    return null;
  }
  return {
    x: pog.positionX,
    y: pog.positionY,
    z: pog.positionZ,
    ...(pog.dimension ? { dimension: pog.dimension } : {}),
  };
}

/**
 * Carries out an accepted request. The acting player (`data.pog`) is the target.
 * `tpa` moves the requester to the target, `tpahere` moves the target to the requester.
 * The requester pays and gets the cooldown, both only after the teleport worked.
 */
export async function fulfil(request) {
  const config = data.module.userConfig;
  const cost = config.cost ?? 0;

  const [requester, target] = await Promise.all([freshPog(request.requesterId), freshPog(data.pog.playerId)]);
  if (!requester.online) {
    throw new TakaroUserError(`${request.requesterName} is no longer online.`);
  }

  if (cost > 0 && (requester.currency ?? 0) < cost) {
    await tell(requester.gameId, `${request.targetName} accepted, but you need ${cost} to teleport and have ${requester.currency ?? 0}.`);
    throw new TakaroUserError(`${request.requesterName} can no longer pay for the teleport.`);
  }

  const here = request.mode === 'here';
  const mover = here ? target : requester;
  const anchor = here ? requester : target;
  const anchorName = here ? request.requesterName : request.targetName;
  const destination = positionOf(anchor);
  if (!destination) {
    throw new TakaroUserError(`The server does not know where ${anchorName} is yet. Try again in a moment.`);
  }

  try {
    await takaro.gameserver.gameServerControllerTeleportPlayer(data.gameServerId, mover.playerId, {
      ...destination,
      y: destination.y + (config.teleportYOffset ?? 0),
    });
  } catch (error) {
    console.log(`Teleport failed: ${error?.message ?? error}`);
    const body = error?.response?.data;
    const reason = body?.meta?.error?.message ?? body?.error?.message;
    const text = reason
      ? `Teleport failed: ${reason}. Nobody was charged.`
      : 'Teleport failed. This server may not support teleporting players. Nobody was charged.';
    await tell(requester.gameId, text);
    throw new TakaroUserError(text);
  }

  if (cost > 0) {
    await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(data.gameServerId, request.requesterId, {
      currency: cost,
    });
  }
  if (!request.bypassCooldown) {
    await startCooldown(request.requesterId, config.cooldown ?? 0);
  }

  const paid = cost > 0 ? ` (-${cost})` : '';
  if (here) {
    await tell(requester.gameId, `${request.targetName} accepted and was teleported to you${paid}.`);
    await data.player.pm(`Teleported to ${request.requesterName}.`);
  } else {
    await tell(requester.gameId, `${request.targetName} accepted. Teleported to ${request.targetName}${paid}.`);
    await data.player.pm(`Accepted. ${request.requesterName} was teleported to you.`);
  }
}

/** Shared body of tpa and tpahere. `mode` is 'to' or 'here'. */
export async function sendRequest(mode) {
  requireUse();
  const { pog, player, arguments: args } = data;
  const config = data.module.userConfig;
  const targetPog = args.player;

  if (targetPog.playerId === pog.playerId) {
    throw new TakaroUserError('You cannot send a teleport request to yourself.');
  }
  const targetName = await playerName(targetPog.playerId);
  if (!targetPog.online) {
    throw new TakaroUserError(`${targetName} is not online.`);
  }

  const [blocks, existing, p] = await Promise.all([readBlocks(targetPog.playerId), outgoingRequest(pog.playerId), prefix()]);
  if (blocks.list.some((b) => b.id === pog.playerId)) {
    throw new TakaroUserError(`${targetName} is not accepting teleport requests from you.`);
  }
  if (existing) {
    throw new TakaroUserError(
      `You already have a request open to ${existing.targetName}. Wait for it, or type ${p}tpcancel first.`,
    );
  }

  const bypassCooldown = Boolean(checkPermission(pog, BYPASS_COOLDOWN_PERMISSION));
  if (!bypassCooldown) {
    const left = await cooldownLeft(pog.playerId);
    if (left > 0) {
      throw new TakaroUserError(`You can send a teleport request again in ${formatDuration(left)}.`);
    }
  }

  const cost = config.cost ?? 0;
  if (cost > 0) {
    const balance = (await freshPog(pog.playerId)).currency ?? 0;
    if (balance < cost) {
      throw new TakaroUserError(`A teleport costs ${cost} and you have ${balance}.`);
    }
  }

  const timeoutMs = config.requestTimeout ?? 60000;
  const now = new Date();
  await createRequest({
    mode,
    requesterId: pog.playerId,
    requesterName: player.name,
    targetId: targetPog.playerId,
    targetName,
    bypassCooldown,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
  });

  const expires = formatDuration(timeoutMs);
  const ask = mode === 'here' ? 'wants you to teleport to them' : 'wants to teleport to you';
  await tell(
    targetPog.gameId,
    `${player.name} ${ask}. Type ${p}tpaccept or ${p}tpdeny (expires in ${expires}).`,
  );
  const costNote = cost > 0 ? ` It costs you ${cost} if accepted.` : '';
  await data.player.pm(`Request sent to ${targetName}. It expires in ${expires}.${costNote}`);
}
