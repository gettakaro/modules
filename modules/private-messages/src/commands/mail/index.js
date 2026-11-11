import { data, TakaroUserError, takaro } from '@takaro/helpers';
import {
  checkCooldown,
  getPlayerName,
  getPrefix,
  isIgnoredBy,
  KEYS,
  loadMailbox,
  parseText,
  pushMail,
  renderTemplate,
  sendTo,
  spyCopy,
  stampCooldown,
  writeVar,
} from './pm-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod, chatMessage } = data;
  const cfg = mod.userConfig;
  const moduleId = mod.moduleId;
  const now = Date.now();

  const target = args.player;
  if (!target || !target.playerId) throw new TakaroUserError('Please name a player to mail.');

  const text = parseText(chatMessage?.msg, 2, args.message, cfg.maxMessageLength);
  if (!text) throw new TakaroUserError('Please write a message.');

  const self = target.playerId === player.id;
  const [prefix, targetName] = await Promise.all([
    getPrefix(gameServerId),
    self ? Promise.resolve(player.name) : getPlayerName(target.playerId, target.name || 'that player'),
  ]);

  if (!self && (await isIgnoredBy(gameServerId, moduleId, target.playerId, pog))) {
    throw new TakaroUserError(`${targetName} is not accepting your messages.`);
  }

  const cooldown = await checkCooldown(gameServerId, moduleId, player.id, cfg.cooldownSeconds, now);
  if (cooldown && cooldown.wait) {
    throw new TakaroUserError(`Slow down: wait ${cooldown.wait}s before sending another message.`);
  }

  const box = await loadMailbox(gameServerId, moduleId, target.playerId, cfg.mailExpiryDays, now);
  const mail = { fromId: player.id, fromName: player.name, text, sentAt: new Date(now).toISOString(), read: false };
  const pushed = pushMail(box.mails, mail, cfg.mailboxSize);
  if (!pushed.ok) throw new TakaroUserError(`${targetName}'s mailbox is full. Try again later.`);
  await writeVar(gameServerId, moduleId, target.playerId, KEYS.mailbox, box.id, pushed.mails);
  await stampCooldown(gameServerId, moduleId, player.id, cooldown, now);

  const unread = pushed.mails.filter((m) => !m.read).length;
  let online = false;
  if (!self) {
    try {
      const res = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, target.playerId);
      const tPog = res.data.data;
      online = Boolean(tPog.online);
      if (online) {
        await sendTo(
          gameServerId,
          tPog.gameId,
          renderTemplate(cfg.newMailNotice, { sender: player.name, count: unread, prefix }),
        );
      }
    } catch (err) {
      console.error(`private-messages: new-mail notice failed: ${err}`);
    }
  }

  await pog.pm(
    online
      ? `Mail sent to ${targetName}. They are online and were told about it.`
      : `Mail sent to ${targetName}. They will get it when they next join.`,
  );
  if (!self) {
    await spyCopy(gameServerId, moduleId, cfg, [player.id, target.playerId], `${player.name} -> ${targetName} (mail): ${text}`);
  }
}

await main();
