import { data } from '@takaro/helpers';
import { formatMail, getPrefix, KEYS, loadMailbox, writeVar } from './pm-helpers.js';

const MAX_ON_JOIN = 5;

async function main() {
  const { gameServerId, player, pog, module: mod } = data;
  if (!player || !pog) return;
  const cfg = mod.userConfig;
  const now = Date.now();

  const box = await loadMailbox(gameServerId, mod.moduleId, player.id, cfg.mailExpiryDays, now);
  if (!box.id) return;
  const unread = box.mails.filter((m) => !m.read);
  if (!unread.length) {
    if (box.pruned) await writeVar(gameServerId, mod.moduleId, player.id, KEYS.mailbox, box.id, box.mails);
    return;
  }

  const prefix = await getPrefix(gameServerId);
  await pog.pm(`You have ${unread.length} new mail${unread.length === 1 ? '' : 's'}:`);
  const shown = unread.slice(0, MAX_ON_JOIN);
  for (const mail of shown) {
    await pog.pm(formatMail(mail, now));
  }
  if (unread.length > shown.length) {
    await pog.pm(`...and ${unread.length - shown.length} more. Type ${prefix}mailbox to read them.`);
  } else {
    await pog.pm(`Reply with ${prefix}mail <player> <text>. Type ${prefix}mailclear to empty your mailbox.`);
  }

  const shownSet = new Set(shown);
  const updated = box.mails.map((m) => (shownSet.has(m) ? { ...m, read: true } : m));
  await writeVar(gameServerId, mod.moduleId, player.id, KEYS.mailbox, box.id, updated);
}

await main();
