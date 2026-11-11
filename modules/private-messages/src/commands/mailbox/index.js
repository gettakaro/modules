import { data } from '@takaro/helpers';
import { formatMail, getPrefix, KEYS, loadMailbox, writeVar } from './pm-helpers.js';

async function main() {
  const { pog, player, gameServerId, module: mod } = data;
  const cfg = mod.userConfig;
  const now = Date.now();

  const [prefix, box] = await Promise.all([
    getPrefix(gameServerId),
    loadMailbox(gameServerId, mod.moduleId, player.id, cfg.mailExpiryDays, now),
  ]);
  if (!box.mails.length) {
    await pog.pm('Your mailbox is empty.');
    if (box.id && box.pruned) await writeVar(gameServerId, mod.moduleId, player.id, KEYS.mailbox, box.id, []);
    return;
  }

  const unread = box.mails.filter((m) => !m.read).length;
  await pog.pm(`Mailbox: ${box.mails.length}/${cfg.mailboxSize} mails, ${unread} new.`);
  for (const mail of box.mails) {
    await pog.pm(`${mail.read ? '' : '[new] '}${formatMail(mail, now)}`);
  }
  await pog.pm(`Type ${prefix}mailclear to empty your mailbox.`);

  if (unread || box.pruned) {
    const updated = box.mails.map((m) => ({ ...m, read: true }));
    await writeVar(gameServerId, mod.moduleId, player.id, KEYS.mailbox, box.id, updated);
  }
}

await main();
