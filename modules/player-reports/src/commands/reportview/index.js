import { data, TakaroUserError, checkPermission } from '@takaro/helpers';
import { PERM_MANAGE, getTicket, getPrefix, parseTicketId, formatPosition, timeAgo } from './report-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod, arguments: args } = data;
  if (!checkPermission(pog, PERM_MANAGE)) {
    throw new TakaroUserError('You do not have permission to manage reports.');
  }

  const prefix = await getPrefix(gameServerId);
  const id = parseTicketId(args.id);
  if (!id) throw new TakaroUserError(`Usage: ${prefix}reportview <id>`);

  const t = await getTicket(gameServerId, mod.moduleId, id);
  if (!t) throw new TakaroUserError(`Report #${id} not found.`);

  await player.pm(`Report #${t.id} [${t.status.toUpperCase()}] - ${timeAgo(t.createdAt)}`);
  await player.pm(`From: ${t.reporter.name} @ ${formatPosition(t.reporter.position)}`);
  if (t.target) {
    const state = t.target.online ? `online @ ${formatPosition(t.target.position)}` : 'offline';
    await player.pm(`About: ${t.target.name} (${state} at report time)`);
  } else {
    await player.pm('About: general issue');
  }
  await player.pm(`Reason: ${t.reason}`);
  if (Array.isArray(t.chat) && t.chat.length > 0) {
    await player.pm(`Last chat of ${t.target ? t.target.name : 'player'}:`);
    for (const line of t.chat) {
      await player.pm(`  ${line.msg}`);
    }
  }
  if (t.status === 'closed') {
    await player.pm(
      `Closed by ${t.closedBy || 'staff'} ${t.closedAt ? timeAgo(t.closedAt) : ''}${t.note ? `: ${t.note}` : ''}`,
    );
  } else {
    await player.pm(`Close: ${prefix}reportclose ${t.id} [note]`);
  }
}

await main();
