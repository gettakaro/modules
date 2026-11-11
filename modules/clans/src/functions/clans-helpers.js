import { takaro, TakaroUserError } from '@takaro/helpers';

// Storage: one variable per clan (`clan:<lowercase name>`, game server + module scope) holding the
// whole clan, plus one per member (`clan_membership`, player scope) as a fast "which clan am I in"
// index. The clan record is the source of truth; a stale index row is cleaned up on read.
export const CLAN_KEY_PREFIX = 'clan:';
export const MEMBERSHIP_KEY = 'clan_membership';

export const ROLE_LEADER = 'leader';
export const ROLE_OFFICER = 'officer';
export const ROLE_MEMBER = 'member';

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export function clanKey(name) {
  return `${CLAN_KEY_PREFIX}${String(name).toLowerCase()}`;
}

async function findVariable(gameServerId, moduleId, key, playerId) {
  const filters = { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] };
  if (playerId) filters.playerId = [playerId];
  const res = await takaro.variable.variableControllerSearch({ filters });
  return res.data.data[0] ?? null;
}

async function writeVariable(gameServerId, moduleId, key, value, playerId) {
  const existing = await findVariable(gameServerId, moduleId, key, playerId);
  const serialized = JSON.stringify(value);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
    return;
  }
  const input = { key, value: serialized, gameServerId, moduleId };
  if (playerId) input.playerId = playerId;
  await takaro.variable.variableControllerCreate(input);
}

async function deleteVariable(gameServerId, moduleId, key, playerId) {
  const existing = await findVariable(gameServerId, moduleId, key, playerId);
  if (existing) await takaro.variable.variableControllerDelete(existing.id);
}

function parseClan(variable) {
  try {
    const clan = JSON.parse(variable.value);
    if (!clan || typeof clan.name !== 'string' || !Array.isArray(clan.members)) return null;
    clan.invites = Array.isArray(clan.invites) ? clan.invites : [];
    clan.bank = Number.isFinite(clan.bank) ? clan.bank : 0;
    return clan;
  } catch (err) {
    console.error(`clans: could not parse ${variable.key}: ${err}`);
    return null;
  }
}

export async function getClan(gameServerId, moduleId, name) {
  if (!name) return null;
  const variable = await findVariable(gameServerId, moduleId, clanKey(name));
  return variable ? parseClan(variable) : null;
}

export async function saveClan(gameServerId, moduleId, clan) {
  await writeVariable(gameServerId, moduleId, clanKey(clan.name), clan);
}

export async function deleteClan(gameServerId, moduleId, clan) {
  await deleteVariable(gameServerId, moduleId, clanKey(clan.name));
  for (const member of clan.members) {
    await deleteVariable(gameServerId, moduleId, MEMBERSHIP_KEY, member.id);
  }
}

export async function listClans(gameServerId, moduleId) {
  const clans = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { gameServerId: [gameServerId], moduleId: [moduleId] },
      search: { key: [CLAN_KEY_PREFIX] },
      limit: PAGE_SIZE,
      page,
    });
    for (const variable of res.data.data) {
      if (!variable.key.startsWith(CLAN_KEY_PREFIX)) continue;
      const clan = parseClan(variable);
      if (clan) clans.push(clan);
    }
    if (res.data.data.length < PAGE_SIZE) break;
  }
  return clans;
}

export async function setMembership(gameServerId, moduleId, playerId, clanName) {
  await writeVariable(gameServerId, moduleId, MEMBERSHIP_KEY, { clan: clanName.toLowerCase() }, playerId);
}

export async function clearMembership(gameServerId, moduleId, playerId) {
  await deleteVariable(gameServerId, moduleId, MEMBERSHIP_KEY, playerId);
}

/** The clan the player is in, or null. Removes a stale index row it finds on the way. */
export async function getPlayerClan(gameServerId, moduleId, playerId) {
  const variable = await findVariable(gameServerId, moduleId, MEMBERSHIP_KEY, playerId);
  if (!variable) return null;
  let clanName = null;
  try {
    clanName = JSON.parse(variable.value).clan;
  } catch {
    clanName = null;
  }
  const clan = await getClan(gameServerId, moduleId, clanName);
  if (!clan || !clan.members.some((member) => member.id === playerId)) {
    await takaro.variable.variableControllerDelete(variable.id);
    return null;
  }
  return clan;
}

export function memberOf(clan, playerId) {
  return clan.members.find((member) => member.id === playerId) ?? null;
}

export function canManage(member) {
  return member && (member.role === ROLE_LEADER || member.role === ROLE_OFFICER);
}

/** Finds a member by name: exact (case-insensitive) first, then a unique partial match. */
export function findMemberByName(clan, query) {
  return pickByName(clan.members, query, 'member of your clan');
}

function pickByName(candidates, query, what) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) throw new TakaroUserError('Please give a player name.');
  const exact = candidates.filter((c) => String(c.name).toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const partial = candidates.filter((c) => String(c.name).toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const names = partial
      .slice(0, 5)
      .map((c) => c.name)
      .join(', ');
    throw new TakaroUserError(`More than one player matches "${query}": ${names}. Please be more specific.`);
  }
  throw new TakaroUserError(`No ${what} matches "${query}".`);
}

/** Online players on this server as { id, gameId, name }. */
export async function getOnlinePlayers(gameServerId, playerIds) {
  const filters = { gameServerId: [gameServerId], online: [true] };
  if (playerIds) {
    if (playerIds.length === 0) return [];
    filters.playerId = playerIds;
  }
  const pogs = (await takaro.playerOnGameserver.playerOnGameServerControllerSearch({ filters, limit: PAGE_SIZE })).data
    .data;
  if (pogs.length === 0) return [];
  const players = (
    await takaro.player.playerControllerSearch({ filters: { id: pogs.map((pog) => pog.playerId) }, limit: PAGE_SIZE })
  ).data.data;
  const names = new Map(players.map((p) => [p.id, p.name]));
  return pogs.map((pog) => ({ id: pog.playerId, gameId: pog.gameId, name: names.get(pog.playerId) ?? pog.gameId }));
}

export async function findOnlinePlayerByName(gameServerId, query) {
  const online = await getOnlinePlayers(gameServerId);
  return pickByName(online, query, 'online player');
}

export async function pmPlayer(gameServerId, gameId, message) {
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message,
    opts: { recipient: { gameId } },
  });
}

/** PMs every online clan member (sequentially, to stay under the outbound request limit). */
export async function pmClan(gameServerId, clan, message, exceptPlayerId) {
  const ids = clan.members.map((m) => m.id).filter((id) => id !== exceptPlayerId);
  const online = await getOnlinePlayers(gameServerId, ids);
  for (const player of online) {
    await pmPlayer(gameServerId, player.gameId, message);
  }
  return online.length;
}

export async function getSetting(key, gameServerId, fallback) {
  try {
    const res = await takaro.settings.settingsControllerGetOne(key, gameServerId);
    return res.data.data.value ?? fallback;
  } catch {
    return fallback;
  }
}

export function validateNameAndTag(name, tag, config, existingClans) {
  const pattern = /^[A-Za-z0-9_]+$/;
  if (!name || !tag) {
    throw new TakaroUserError('Usage: clan create <name> <tag>');
  }
  if (name.length < config.nameMinLength || name.length > config.nameMaxLength) {
    throw new TakaroUserError(
      `Clan name must be ${config.nameMinLength}-${config.nameMaxLength} characters long.`,
    );
  }
  if (tag.length < config.tagMinLength || tag.length > config.tagMaxLength) {
    throw new TakaroUserError(`Clan tag must be ${config.tagMinLength}-${config.tagMaxLength} characters long.`);
  }
  if (!pattern.test(name) || !pattern.test(tag)) {
    throw new TakaroUserError('Clan name and tag may only use letters, numbers and _.');
  }
  const blocked = (config.blockedWords ?? []).map((w) => String(w).toLowerCase()).filter(Boolean);
  const lowerName = name.toLowerCase();
  const lowerTag = tag.toLowerCase();
  if (blocked.some((word) => lowerName.includes(word) || lowerTag.includes(word))) {
    throw new TakaroUserError('That clan name or tag is not allowed.');
  }
  if (existingClans.some((c) => c.name.toLowerCase() === lowerName)) {
    throw new TakaroUserError(`A clan called "${name}" already exists.`);
  }
  if (existingClans.some((c) => String(c.tag).toLowerCase() === lowerTag)) {
    throw new TakaroUserError(`The tag [${tag}] is already taken.`);
  }
}

export function parseAmount(raw) {
  const amount = Number(raw);
  if (!Number.isInteger(amount) || amount < 1) {
    throw new TakaroUserError('Amount must be a positive whole number.');
  }
  return amount;
}

export function formatPlaytime(seconds) {
  const hours = Math.floor((seconds || 0) / 3600);
  if (hours >= 1) return `${hours}h`;
  return `${Math.floor((seconds || 0) / 60)}m`;
}

/** Total playtime on this server per clan, from one paged player-on-gameserver search. */
export async function clanPlaytimes(gameServerId, clans) {
  const owner = new Map();
  for (const clan of clans) for (const m of clan.members) owner.set(m.id, clan.name);
  const totals = new Map(clans.map((c) => [c.name, 0]));
  const ids = [...owner.keys()];
  for (let i = 0; i < ids.length; i += PAGE_SIZE) {
    const chunk = ids.slice(i, i + PAGE_SIZE);
    const pogs = (
      await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [gameServerId], playerId: chunk },
        limit: PAGE_SIZE,
      })
    ).data.data;
    for (const pog of pogs) {
      const name = owner.get(pog.playerId);
      if (name) totals.set(name, totals.get(name) + (pog.playtimeSeconds || 0));
    }
  }
  return totals;
}
