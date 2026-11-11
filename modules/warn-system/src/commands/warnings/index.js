import { data, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  daysLeft,
  describeStep,
  formatDate,
  loadRecord,
  nextEscalation,
  pruneExpired,
  resolvePlayerByName,
  saveRecord,
} from './warn-helpers.js';

const SELF_WORDS = ['', 'me', 'self', 'myself'];
const MAX_LINES = 10;

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;
  const cfg = mod.userConfig;
  const input = String(args.player ?? '').trim();
  const isSelf = SELF_WORDS.includes(input.toLowerCase());

  let targetId = player.id;
  let targetName = player.name;
  if (!isSelf) {
    if (!checkPermission(pog, 'WARN_ISSUE') && !checkPermission(pog, 'WARN_MANAGE')) {
      throw new TakaroUserError('You can only view your own warnings. Use the command without a name.');
    }
    const found = await resolvePlayerByName(gameServerId, input);
    if (found.error) throw new TakaroUserError(found.error);
    targetId = found.playerId;
    targetName = found.name;
  }
  const own = targetId === player.id;

  const now = Date.now();
  const { variableId, record } = await loadRecord(gameServerId, mod.moduleId, targetId);
  const removed = pruneExpired(record, cfg.warningExpiryDays, now);
  const count = record.warnings.length;

  // Reading your own list counts as being told; it also saves the pruned list.
  const undelivered = own ? record.warnings.filter((w) => !w.delivered) : [];
  undelivered.forEach((w) => {
    w.delivered = true;
  });
  if (variableId && (removed > 0 || undelivered.length > 0)) {
    await saveRecord(gameServerId, mod.moduleId, targetId, variableId, record);
  }

  const who = own ? 'You have' : `${targetName} has`;
  if (count === 0) {
    await pog.pm(`${who} no active warnings.`);
    return;
  }

  await pog.pm(`${who} ${count} active warning${count === 1 ? '' : 's'}:`);
  const shown = record.warnings.slice(-MAX_LINES);
  for (const w of shown) {
    const left = daysLeft(w, cfg.warningExpiryDays, now);
    const expiry = left === null ? '' : ` (expires in ${left}d)`;
    await pog.pm(`#${w.id} ${formatDate(w.createdAt)} by ${w.staffName}: ${w.reason}${expiry}`);
  }
  if (count > shown.length) {
    await pog.pm(`...and ${count - shown.length} older warning(s).`);
  }

  const next = nextEscalation(cfg.escalation, count);
  if (next) {
    await pog.pm(`At ${next.warnings} warnings: ${describeStep(next)}.`);
  }
}

await main();
