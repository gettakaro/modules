import { takaro, checkPermission } from '@takaro/helpers';

export const COUNTER_KEY = 'pr_counter';
export const OPEN_INDEX_KEY = 'pr_open';
export const COOLDOWN_KEY = 'pr_last_report';
export const NOTICE_KEY = 'pr_notices';
export const TICKET_PREFIX = 'pr_ticket_';

export const PERM_RECEIVE = 'REPORTS_RECEIVE';
export const PERM_MANAGE = 'REPORTS_MANAGE';

// ---------- variables ----------

async function findVariable(gameServerId, moduleId, key, playerId) {
  const filters = { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] };
  if (playerId) filters.playerId = [playerId];
  const res = await takaro.variable.variableControllerSearch({ filters, limit: 1 });
  return res.data.data.length > 0 ? res.data.data[0] : null;
}

export async function readJson(gameServerId, moduleId, key, playerId, fallback) {
  const variable = await findVariable(gameServerId, moduleId, key, playerId);
  if (!variable) return fallback;
  try {
    return JSON.parse(variable.value);
  } catch (err) {
    console.error(`player-reports: could not parse variable ${key}: ${err}`);
    return fallback;
  }
}

export async function writeJson(gameServerId, moduleId, key, playerId, value) {
  const existing = await findVariable(gameServerId, moduleId, key, playerId);
  const serialized = JSON.stringify(value);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
    return;
  }
  const createData = { key, value: serialized, gameServerId, moduleId };
  if (playerId) createData.playerId = playerId;
  await takaro.variable.variableControllerCreate(createData);
}

export async function deleteVariable(gameServerId, moduleId, key, playerId) {
  const existing = await findVariable(gameServerId, moduleId, key, playerId);
  if (existing) await takaro.variable.variableControllerDelete(existing.id);
}

// Read-modify-write: two reports in the same instant could get the same id. Accepted; rare.
export async function nextTicketId(gameServerId, moduleId) {
  const current = await readJson(gameServerId, moduleId, COUNTER_KEY, null, 0);
  const next = (Number(current) || 0) + 1;
  await writeJson(gameServerId, moduleId, COUNTER_KEY, null, next);
  return next;
}

export function getTicket(gameServerId, moduleId, id) {
  return readJson(gameServerId, moduleId, `${TICKET_PREFIX}${id}`, null, null);
}

export function saveTicket(gameServerId, moduleId, ticket) {
  return writeJson(gameServerId, moduleId, `${TICKET_PREFIX}${ticket.id}`, null, ticket);
}

/** Open index: [{ id, reporterId, reporterName, targetName, reason, createdAt }] */
export async function getOpenIndex(gameServerId, moduleId) {
  const list = await readJson(gameServerId, moduleId, OPEN_INDEX_KEY, null, []);
  return Array.isArray(list) ? list : [];
}

export function saveOpenIndex(gameServerId, moduleId, list) {
  return writeJson(gameServerId, moduleId, OPEN_INDEX_KEY, null, list);
}

// ---------- settings / text ----------

export async function getPrefix(gameServerId) {
  try {
    const res = await takaro.settings.settingsControllerGetOne('commandPrefix', gameServerId);
    return res.data.data.value || '/';
  } catch {
    return '/';
  }
}

/**
 * The raw chat text after the first `skip` words (word 0 is prefix+trigger).
 * Takaro splits arguments on spaces, so a multi-word reason is read from the chat line itself.
 */
export function textAfter(chatMessage, skip, fallback) {
  const msg = chatMessage && typeof chatMessage.msg === 'string' ? chatMessage.msg.trim() : '';
  if (!msg) return (fallback ?? '').toString().trim();
  const parts = msg.split(/\s+/);
  return parts.slice(skip).join(' ').trim();
}

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, Math.max(0, max - 3))}...` : s;
}

export function timeAgo(iso, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatPosition(pos) {
  if (!pos) return 'unknown';
  const r = (n) => Math.round(Number(n));
  return `${r(pos.x)}, ${r(pos.y)}, ${r(pos.z)}`;
}

export function positionOf(pog) {
  if (!pog) return null;
  const { positionX: x, positionY: y, positionZ: z } = pog;
  if ([x, y, z].some((n) => n === null || n === undefined || Number.isNaN(Number(n)))) return null;
  return { x: Number(x), y: Number(y), z: Number(z) };
}

export function parseTicketId(raw) {
  const id = parseInt(String(raw ?? '').replace(/^#/, ''), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ---------- players ----------

export async function getOnlinePogs(gameServerId) {
  const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: { gameServerId: [gameServerId], online: [true] },
    limit: 100,
  });
  return res.data.data;
}

async function getPlayersByIds(ids) {
  if (ids.length === 0) return [];
  const res = await takaro.player.playerControllerSearch({ filters: { id: ids }, limit: 100 });
  return res.data.data;
}

/**
 * Resolve a name to a player. Online players first (exact, then unique partial match of 3+ chars),
 * then an exact name across all known players.
 * Returns { player, pog } | { ambiguous: [names] } | null
 */
export async function resolvePlayer(gameServerId, rawName) {
  const name = String(rawName ?? '').trim();
  if (!name) return null;
  const lower = name.toLowerCase();

  const onlinePogs = await getOnlinePogs(gameServerId);
  const onlinePlayers = await getPlayersByIds(onlinePogs.map((p) => p.playerId));
  const pogFor = (playerId) => onlinePogs.find((p) => p.playerId === playerId);

  const exact = onlinePlayers.filter((p) => String(p.name ?? '').toLowerCase() === lower);
  if (exact.length === 1) return { player: exact[0], pog: pogFor(exact[0].id) };

  if (name.length >= 3) {
    const partial = onlinePlayers.filter((p) => String(p.name ?? '').toLowerCase().includes(lower));
    if (partial.length === 1) return { player: partial[0], pog: pogFor(partial[0].id) };
    if (partial.length > 1) return { ambiguous: partial.map((p) => p.name) };
  }

  const known = await takaro.player.playerControllerSearch({ filters: { name: [name] }, limit: 2 });
  const match = known.data.data[0];
  if (!match) return null;
  const pogRes = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: { gameServerId: [gameServerId], playerId: [match.id] },
    limit: 1,
  });
  return { player: match, pog: pogRes.data.data[0] ?? null };
}

export async function pmPlayer(gameServerId, gameId, message) {
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message,
    opts: { recipient: { gameId } },
  });
}

/** Online players holding REPORTS_RECEIVE (ROOT counts). */
export async function getOnlineReceivers(gameServerId) {
  const pogs = await getOnlinePogs(gameServerId);
  return pogs.filter((pog) => Array.isArray(pog.roles) && checkPermission(pog, PERM_RECEIVE));
}

// ---------- context ----------

export async function getRecentChat(gameServerId, playerId, limit) {
  if (!limit || limit <= 0 || !playerId) return [];
  try {
    const res = await takaro.event.eventControllerSearch({
      filters: { eventName: ['chat-message'], playerId: [playerId], gameserverId: [gameServerId] },
      sortBy: 'createdAt',
      sortDirection: 'desc',
      limit,
    });
    return res.data.data
      .map((e) => ({ at: e.createdAt, msg: truncate(e.meta?.msg ?? '', 150) }))
      .filter((line) => line.msg)
      .reverse();
  } catch (err) {
    console.error(`player-reports: could not load chat context: ${err}`);
    return [];
  }
}

// ---------- notices for offline reporters ----------

export async function deliverOrQueueNotice(gameServerId, moduleId, reporter, message) {
  try {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], playerId: [reporter.playerId], online: [true] },
      limit: 1,
    });
    const pog = res.data.data[0];
    if (pog) {
      await pmPlayer(gameServerId, pog.gameId, message);
      return 'sent';
    }
  } catch (err) {
    console.error(`player-reports: could not PM reporter: ${err}`);
  }
  const queue = await readJson(gameServerId, moduleId, NOTICE_KEY, reporter.playerId, []);
  const list = Array.isArray(queue) ? queue : [];
  list.push(message);
  await writeJson(gameServerId, moduleId, NOTICE_KEY, reporter.playerId, list.slice(-5));
  return 'queued';
}
