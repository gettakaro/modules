import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import {
  JAIL_KEY,
  getPoint,
  getPrefix,
  getRecord,
  saveRecord,
  positionOf,
  findPog,
  teleport,
  assignJailedRole,
  pmPlayer,
  broadcast,
  playerName,
  formatRemaining,
  parseReason,
  requireManage,
} from './jail-helpers.js';

async function main() {
  requireManage(checkPermission);
  const { arguments: args, module: mod, chatMessage } = data;
  const target = args.target;
  const minutes = Number(args.minutes);
  const reason = parseReason(chatMessage?.msg, args.reason) || 'No reason given';
  const prefix = await getPrefix();

  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new TakaroUserError(`Minutes must be a whole number of 0 or more. Usage: ${prefix}jail <player> <minutes> <reason>`);
  }
  if (minutes > mod.userConfig.maxMinutes) {
    throw new TakaroUserError(`The maximum jail time is ${mod.userConfig.maxMinutes} minutes.`);
  }
  if (target.playerId === data.pog.playerId) {
    throw new TakaroUserError('You cannot jail yourself.');
  }

  const jail = await getPoint(JAIL_KEY);
  if (!jail) {
    throw new TakaroUserError(`No jail set yet. Stand in the jail and use ${prefix}setjail first.`);
  }

  const name = await playerName(target.playerId);
  const existing = await getRecord(target.playerId);
  if (existing && existing.status === 'jailed') {
    throw new TakaroUserError(`${name} is already jailed (${formatRemaining(existing)} left). Use ${prefix}unjail ${name} first.`);
  }

  const pog = (await findPog(target.playerId)) ?? target;
  const online = Boolean(pog.online);

  // Teleport first: if this game cannot teleport, nobody gets jailed.
  if (online) {
    try {
      await teleport(target.playerId, jail);
    } catch (err) {
      console.log(`Teleport failed: ${err?.message ?? err}`);
      throw new TakaroUserError(
        `Could not teleport ${name}. This game or connector may not support teleporting players. ${name} was not jailed.`,
      );
    }
  }

  const now = new Date();
  const record = {
    status: 'jailed',
    name,
    reason,
    by: data.player.name,
    startedAt: now.toISOString(),
    until: minutes === 0 ? null : new Date(now.getTime() + minutes * 60000).toISOString(),
    returnTo: existing?.returnTo ?? positionOf(pog),
    roleId: null,
  };
  if (await assignJailedRole(target.playerId)) {
    record.roleId = mod.userConfig.jailedRoleId;
  }
  await saveRecord(target.playerId, record);

  const duration = minutes === 0 ? 'until released by staff' : `for ${formatRemaining(record, now)}`;
  if (online && pog.gameId) {
    await pmPlayer(pog.gameId, `You have been jailed ${duration}. Reason: ${reason}. Type ${prefix}jailtime to see time left.`);
  }
  await broadcast(`${name} was jailed ${duration}. Reason: ${reason}`);
  await data.player.pm(
    online
      ? `${name} jailed ${duration}.`
      : `${name} is offline. They are jailed ${duration} and will be put in jail when they join.`,
  );
}

await main();
