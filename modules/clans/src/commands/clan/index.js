import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  ROLE_LEADER,
  ROLE_MEMBER,
  ROLE_OFFICER,
  canManage,
  clanPlaytimes,
  clearMembership,
  deleteClan,
  findMemberByName,
  findOnlinePlayerByName,
  formatPlaytime,
  getClan,
  getPlayerClan,
  getSetting,
  listClans,
  memberOf,
  parseAmount,
  pmClan,
  pmPlayer,
  saveClan,
  setMembership,
  validateNameAndTag,
} from './clans-helpers.js';

const { pog, player, gameServerId, arguments: args, module: mod } = data;
const config = mod.userConfig;
const moduleId = mod.moduleId;

// Takaro treats an empty-string default as "no default", so optional arguments default to '-'.
function argValue(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  return text === '-' ? '' : text;
}
const arg1 = argValue(args.arg1);
const arg2 = argValue(args.arg2);

let prefix = '/';
let currencyName = 'coins';

/** Words typed after `<prefix>clan` and the first `skip` words; keeps spaces in names and chat. */
function rest(skip) {
  const msg = data.chatMessage?.msg;
  if (typeof msg === 'string') {
    const fromChat = msg.trim().split(/\s+/).slice(1 + skip).join(' ');
    if (fromChat) return fromChat;
  }
  return [arg1, arg2]
    .slice(skip - 1)
    .filter(Boolean)
    .join(' ');
}

function memberCount(count) {
  return `${count} member${count === 1 ? '' : 's'}`;
}

function label(clan) {
  return `[${clan.tag}] ${clan.name}`;
}

async function requireClan() {
  const clan = await getPlayerClan(gameServerId, moduleId, player.id);
  if (!clan) throw new TakaroUserError(`You are not in a clan. Use ${prefix}clan create or ask for an invite.`);
  return clan;
}

async function help() {
  const lines = [
    `Clans: ${prefix}clan create <name> <tag> | invite <player> | join <name> | leave`,
    `${prefix}clan info [name] | list | top | chat <message>`,
    `Leaders/officers: ${prefix}clan kick <player> | promote <player> | demote <player> | disband`,
  ];
  if (config.enableBank) lines.push(`${prefix}clan bank | bank deposit <amount> | bank withdraw <amount> (leader)`);
  for (const line of lines) await player.pm(line);
}

async function create() {
  if (!checkPermission(pog, 'CLANS_CREATE')) {
    throw new TakaroUserError('You do not have permission to create a clan.');
  }
  const name = arg1;
  const tag = arg2;
  if (await getPlayerClan(gameServerId, moduleId, player.id)) {
    throw new TakaroUserError(`You are already in a clan. Use ${prefix}clan leave first.`);
  }
  const clans = await listClans(gameServerId, moduleId);
  validateNameAndTag(name, tag, config, clans);
  if (config.maxClans > 0 && clans.length >= config.maxClans) {
    throw new TakaroUserError('The maximum number of clans on this server has been reached.');
  }

  const cost = config.createCost;
  if (cost > 0) {
    if ((pog.currency ?? 0) < cost) {
      throw new TakaroUserError(`Creating a clan costs ${cost} ${currencyName}. You have ${pog.currency ?? 0}.`);
    }
    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, player.id, {
        currency: cost,
      });
    } catch (err) {
      console.error(`clans: deduct failed: ${err}`);
      throw new TakaroUserError(`Could not take ${cost} ${currencyName}. Is the economy enabled on this server?`);
    }
  }

  const now = new Date().toISOString();
  const clan = {
    name,
    tag,
    createdAt: now,
    bank: 0,
    members: [{ id: player.id, name: player.name, role: ROLE_LEADER, joinedAt: now }],
    invites: [],
  };
  await saveClan(gameServerId, moduleId, clan);
  await setMembership(gameServerId, moduleId, player.id, name);
  const paid = cost > 0 ? ` for ${cost} ${currencyName}` : '';
  await player.pm(`Clan ${label(clan)} created${paid}. Invite players with ${prefix}clan invite <player>.`);
}

async function invite() {
  const clan = await requireClan();
  const me = memberOf(clan, player.id);
  if (!canManage(me)) throw new TakaroUserError('Only the clan leader or officers can invite players.');
  if (clan.members.length >= config.maxMembers) {
    throw new TakaroUserError(`Your clan is full (${config.maxMembers} members).`);
  }
  const target = await findOnlinePlayerByName(gameServerId, rest(1));
  if (target.id === player.id) throw new TakaroUserError('You cannot invite yourself.');
  if (memberOf(clan, target.id)) throw new TakaroUserError(`${target.name} is already in your clan.`);
  if (await getPlayerClan(gameServerId, moduleId, target.id)) {
    throw new TakaroUserError(`${target.name} is already in another clan.`);
  }
  const expiresAt = new Date(Date.now() + config.inviteExpiryMinutes * 60 * 1000).toISOString();
  clan.invites = clan.invites.filter((i) => i.id !== target.id && new Date(i.expiresAt) > new Date());
  clan.invites.push({ id: target.id, name: target.name, by: player.name, expiresAt });
  await saveClan(gameServerId, moduleId, clan);
  await pmPlayer(
    gameServerId,
    target.gameId,
    `${player.name} invited you to clan ${label(clan)}. Type ${prefix}clan join ${clan.name} within ${config.inviteExpiryMinutes} minutes.`,
  );
  await player.pm(`Invite sent to ${target.name}.`);
}

async function join() {
  const name = arg1;
  if (!name) throw new TakaroUserError(`Usage: ${prefix}clan join <name>`);
  if (await getPlayerClan(gameServerId, moduleId, player.id)) {
    throw new TakaroUserError(`You are already in a clan. Use ${prefix}clan leave first.`);
  }
  const clan = await getClan(gameServerId, moduleId, name);
  if (!clan) throw new TakaroUserError(`No clan called "${name}".`);
  const now = new Date();
  const invitation = clan.invites.find((i) => i.id === player.id && new Date(i.expiresAt) > now);
  if (!invitation) throw new TakaroUserError(`You have no open invite from ${label(clan)}.`);
  if (clan.members.length >= config.maxMembers) throw new TakaroUserError(`${label(clan)} is full.`);

  clan.invites = clan.invites.filter((i) => i.id !== player.id && new Date(i.expiresAt) > now);
  clan.members.push({ id: player.id, name: player.name, role: ROLE_MEMBER, joinedAt: now.toISOString() });
  await saveClan(gameServerId, moduleId, clan);
  await setMembership(gameServerId, moduleId, player.id, clan.name);
  await pmClan(gameServerId, clan, `[${clan.tag}] ${player.name} joined the clan.`, player.id);
  await player.pm(`You joined ${label(clan)}.`);
}

async function payOut(playerId, amount) {
  if (amount <= 0) return;
  await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, {
    currency: amount,
  });
}

async function disbandClan(clan, reason) {
  const leader = clan.members.find((m) => m.role === ROLE_LEADER) ?? clan.members[0];
  if (clan.bank > 0 && leader) {
    try {
      await payOut(leader.id, clan.bank);
    } catch (err) {
      console.error(`clans: bank refund failed: ${err}`);
    }
  }
  await pmClan(gameServerId, clan, `[${clan.tag}] ${reason}`, player.id);
  await deleteClan(gameServerId, moduleId, clan);
}

async function leave() {
  const clan = await requireClan();
  const me = memberOf(clan, player.id);
  if (clan.members.length === 1) {
    const refund = clan.bank > 0 ? ` The clan bank (${clan.bank} ${currencyName}) was paid to you.` : '';
    await disbandClan(clan, 'The clan was disbanded.');
    await player.pm(`You left and ${label(clan)} was disbanded.${refund}`);
    return;
  }
  clan.members = clan.members.filter((m) => m.id !== player.id);
  let note = '';
  if (me.role === ROLE_LEADER) {
    const heir = clan.members.find((m) => m.role === ROLE_OFFICER) ?? clan.members[0];
    heir.role = ROLE_LEADER;
    note = ` ${heir.name} is the new leader.`;
  }
  await saveClan(gameServerId, moduleId, clan);
  await clearMembership(gameServerId, moduleId, player.id);
  await pmClan(gameServerId, clan, `[${clan.tag}] ${player.name} left the clan.${note}`);
  await player.pm(`You left ${label(clan)}.`);
}

async function kick() {
  const clan = await requireClan();
  const me = memberOf(clan, player.id);
  if (!canManage(me)) throw new TakaroUserError('Only the clan leader or officers can kick members.');
  const target = findMemberByName(clan, rest(1));
  if (target.id === player.id) throw new TakaroUserError(`Use ${prefix}clan leave to leave your clan.`);
  if (me.role !== ROLE_LEADER && target.role !== ROLE_MEMBER) {
    throw new TakaroUserError('Officers can only kick regular members.');
  }
  clan.members = clan.members.filter((m) => m.id !== target.id);
  await saveClan(gameServerId, moduleId, clan);
  await clearMembership(gameServerId, moduleId, target.id);
  // The kicked player is no longer a member, so add them back for this one notice.
  const notify = { ...clan, members: [...clan.members, target] };
  await pmClan(gameServerId, notify, `[${clan.tag}] ${target.name} was kicked by ${player.name}.`, player.id);
  await player.pm(`${target.name} was kicked from the clan.`);
}

async function setRole(newRole) {
  const clan = await requireClan();
  const me = memberOf(clan, player.id);
  if (me.role !== ROLE_LEADER) throw new TakaroUserError('Only the clan leader can change ranks.');
  const target = findMemberByName(clan, rest(1));
  if (target.id === player.id) throw new TakaroUserError('You cannot change your own rank.');
  if (target.role === newRole) throw new TakaroUserError(`${target.name} is already ${newRole}.`);
  target.role = newRole;
  await saveClan(gameServerId, moduleId, clan);
  await pmClan(gameServerId, clan, `[${clan.tag}] ${target.name} is now ${newRole}.`);
}

async function disband() {
  const name = arg1;
  if (name && checkPermission(pog, 'CLANS_ADMIN')) {
    const clan = await getClan(gameServerId, moduleId, name);
    if (!clan) throw new TakaroUserError(`No clan called "${name}".`);
    await disbandClan(clan, `The clan was disbanded by an admin.`);
    await player.pm(`${label(clan)} was disbanded.`);
    return;
  }
  const clan = await requireClan();
  if (name && name.toLowerCase() !== clan.name.toLowerCase()) {
    throw new TakaroUserError('You can only disband your own clan.');
  }
  if (memberOf(clan, player.id).role !== ROLE_LEADER) {
    throw new TakaroUserError('Only the clan leader can disband the clan.');
  }
  await disbandClan(clan, `${player.name} disbanded the clan.`);
  const refund = clan.bank > 0 ? ` The clan bank (${clan.bank} ${currencyName}) was paid to you.` : '';
  await player.pm(`${label(clan)} was disbanded.${refund}`);
}

async function info() {
  const name = arg1;
  const clan = name ? await getClan(gameServerId, moduleId, name) : await requireClan();
  if (!clan) throw new TakaroUserError(`No clan called "${name}".`);
  const leader = clan.members.find((m) => m.role === ROLE_LEADER);
  const officers = clan.members.filter((m) => m.role === ROLE_OFFICER).map((m) => m.name);
  const members = clan.members.filter((m) => m.role === ROLE_MEMBER).map((m) => m.name);
  await player.pm(`${label(clan)} - ${clan.members.length}/${config.maxMembers} members`);
  await player.pm(`Leader: ${leader ? leader.name : '-'}`);
  if (officers.length) await player.pm(`Officers: ${officers.join(', ')}`);
  if (members.length) await player.pm(`Members: ${members.join(', ')}`);
  if (config.enableBank) await player.pm(`Bank: ${clan.bank} ${currencyName}`);
}

async function list() {
  const clans = await listClans(gameServerId, moduleId);
  if (clans.length === 0) {
    await player.pm(`There are no clans yet. Start one with ${prefix}clan create <name> <tag>.`);
    return;
  }
  clans.sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
  await player.pm(`Clans (${clans.length}):`);
  for (const clan of clans.slice(0, config.listLimit)) {
    await player.pm(`${label(clan)} - ${memberCount(clan.members.length)}`);
  }
}

async function top() {
  const clans = await listClans(gameServerId, moduleId);
  if (clans.length === 0) {
    await player.pm('There are no clans yet.');
    return;
  }
  const totals = await clanPlaytimes(gameServerId, clans);
  clans.sort((a, b) => totals.get(b.name) - totals.get(a.name));
  await player.pm('Top clans by total member playtime:');
  let rank = 1;
  for (const clan of clans.slice(0, config.listLimit)) {
    await player.pm(`${rank}. ${label(clan)} - ${formatPlaytime(totals.get(clan.name))} (${memberCount(clan.members.length)})`);
    rank++;
  }
}

async function chat() {
  const clan = await requireClan();
  const message = rest(1).slice(0, 200);
  if (!message) throw new TakaroUserError(`Usage: ${prefix}clan chat <message>`);
  const text = config.chatFormat
    .replace('{tag}', clan.tag)
    .replace('{player}', player.name)
    .replace('{message}', message);
  const sent = await pmClan(gameServerId, clan, text);
  if (sent <= 1) await player.pm('(No other clan members are online.)');
}

async function bank() {
  if (!config.enableBank) throw new TakaroUserError('The clan bank is disabled on this server.');
  const clan = await requireClan();
  const sub = arg1.toLowerCase();
  if (!sub) {
    await player.pm(`${label(clan)} bank: ${clan.bank} ${currencyName}`);
    return;
  }
  if (sub !== 'deposit' && sub !== 'withdraw') {
    throw new TakaroUserError(`Usage: ${prefix}clan bank [deposit|withdraw] <amount>`);
  }
  const amount = parseAmount(arg2);

  if (sub === 'deposit') {
    if ((pog.currency ?? 0) < amount) {
      throw new TakaroUserError(`You only have ${pog.currency ?? 0} ${currencyName}.`);
    }
    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, player.id, {
        currency: amount,
      });
    } catch (err) {
      console.error(`clans: deposit deduct failed: ${err}`);
      throw new TakaroUserError(`Could not take ${amount} ${currencyName}. Is the economy enabled on this server?`);
    }
    // Re-read so a concurrent deposit is not overwritten.
    const fresh = (await getClan(gameServerId, moduleId, clan.name)) ?? clan;
    fresh.bank += amount;
    await saveClan(gameServerId, moduleId, fresh);
    await pmClan(gameServerId, fresh, `[${fresh.tag}] ${player.name} deposited ${amount} ${currencyName}. Bank: ${fresh.bank}.`);
    return;
  }

  if (memberOf(clan, player.id).role !== ROLE_LEADER) {
    throw new TakaroUserError('Only the clan leader can withdraw from the bank.');
  }
  if (amount > clan.bank) throw new TakaroUserError(`The bank only holds ${clan.bank} ${currencyName}.`);
  clan.bank -= amount;
  await saveClan(gameServerId, moduleId, clan);
  try {
    await payOut(player.id, amount);
  } catch (err) {
    clan.bank += amount;
    await saveClan(gameServerId, moduleId, clan);
    console.error(`clans: withdraw failed: ${err}`);
    throw new TakaroUserError('Could not pay out. Is the economy enabled on this server?');
  }
  await pmClan(gameServerId, clan, `[${clan.tag}] ${player.name} withdrew ${amount} ${currencyName}. Bank: ${clan.bank}.`);
}

const actions = {
  create,
  invite,
  join,
  leave,
  kick,
  promote: () => setRole(ROLE_OFFICER),
  demote: () => setRole(ROLE_MEMBER),
  disband,
  info,
  list,
  top,
  chat,
  c: chat,
  bank,
  help,
};

async function main() {
  if (!checkPermission(pog, 'CLANS_USE')) {
    throw new TakaroUserError('You do not have permission to use clans.');
  }
  [prefix, currencyName] = await Promise.all([
    getSetting('commandPrefix', gameServerId, '/'),
    getSetting('currencyName', gameServerId, 'coins'),
  ]);
  const action = String(args.action ?? '').toLowerCase();
  const handler = actions[action] ?? help;
  await handler();
}

await main();
