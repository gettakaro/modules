import { data, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  PERM_MANAGE,
  getTicket,
  saveTicket,
  getOpenIndex,
  saveOpenIndex,
  getPrefix,
  parseTicketId,
  textAfter,
  truncate,
  deliverOrQueueNotice,
} from './report-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod, arguments: args, chatMessage } = data;
  const moduleId = mod.moduleId;
  if (!checkPermission(pog, PERM_MANAGE)) {
    throw new TakaroUserError('You do not have permission to manage reports.');
  }

  const prefix = await getPrefix(gameServerId);
  const id = parseTicketId(args.id);
  if (!id) throw new TakaroUserError(`Usage: ${prefix}reportclose <id> [note]`);

  const t = await getTicket(gameServerId, moduleId, id);
  if (!t) throw new TakaroUserError(`Report #${id} not found.`);
  if (t.status === 'closed') throw new TakaroUserError(`Report #${id} is already closed.`);

  const note = truncate(textAfter(chatMessage, 2, args.note), 200);
  t.status = 'closed';
  t.closedAt = new Date().toISOString();
  t.closedBy = player.name;
  t.note = note || '';
  await saveTicket(gameServerId, moduleId, t);

  const open = await getOpenIndex(gameServerId, moduleId);
  await saveOpenIndex(
    gameServerId,
    moduleId,
    open.filter((entry) => entry.id !== id),
  );

  const notice = `Your report #${id} was handled by staff.${note ? ` Note: ${note}` : ''}`;
  let delivery = 'skipped';
  if (t.reporter && t.reporter.playerId && t.reporter.playerId !== player.id) {
    delivery = await deliverOrQueueNotice(gameServerId, moduleId, t.reporter, notice);
  }

  const who = delivery === 'sent' ? ' Reporter notified.' : delivery === 'queued' ? ' Reporter will be told on next login.' : '';
  await player.pm(`Report #${id} closed.${who}`);
}

await main();
