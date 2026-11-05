import { data, TakaroUserError } from '@takaro/helpers';
import { deliverPrivate, getPrefix, KEYS, parseText, readVar } from './pm-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod, chatMessage } = data;
  const cfg = mod.userConfig;

  const [prefix, reply] = await Promise.all([
    getPrefix(gameServerId),
    readVar(gameServerId, mod.moduleId, player.id, KEYS.replyTo, null),
  ]);
  const last = reply.value;
  if (!last || !last.playerId) {
    throw new TakaroUserError(`Nobody has messaged you yet. Use ${prefix}msg <player> <text>.`);
  }

  const text = parseText(chatMessage?.msg, 1, args.message, cfg.maxMessageLength);
  if (!text) throw new TakaroUserError('Please write a message.');

  const error = await deliverPrivate({
    gameServerId,
    moduleId: mod.moduleId,
    cfg,
    senderPog: pog,
    senderName: player.name,
    target: { playerId: last.playerId, name: last.name },
    text,
    prefix,
    now: Date.now(),
  });
  if (error) throw new TakaroUserError(error);
}

await main();
