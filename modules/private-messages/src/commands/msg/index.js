import { data, TakaroUserError } from '@takaro/helpers';
import { deliverPrivate, getPlayerName, getPrefix, parseText } from './pm-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod, chatMessage } = data;
  const cfg = mod.userConfig;

  const target = args.player;
  if (!target || !target.playerId) throw new TakaroUserError('Please name a player to message.');

  const text = parseText(chatMessage?.msg, 2, args.message, cfg.maxMessageLength);
  if (!text) throw new TakaroUserError('Please write a message.');

  const [prefix, targetName] = await Promise.all([
    getPrefix(gameServerId),
    getPlayerName(target.playerId, target.name || 'that player'),
  ]);
  const error = await deliverPrivate({
    gameServerId,
    moduleId: mod.moduleId,
    cfg,
    senderPog: pog,
    senderName: player.name,
    target: { playerId: target.playerId, name: targetName },
    text,
    prefix,
    now: Date.now(),
  });
  if (error) throw new TakaroUserError(error);
}

await main();
