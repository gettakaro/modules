import { data, takaro } from '@takaro/helpers';
import { getDiscordChannelFromHook, pickAuthorName, pickText } from './discord-7d2d-status-helpers.js';

async function main() {
  const { gameServerId, eventData, module: mod } = data;
  const config = mod.userConfig;
  if (config.relayDiscordToGame === false) return;
  const expectedChannelId = getDiscordChannelFromHook(data, config.chatChannelId, 'discordChatRelay');
  const eventChannelId = eventData?.discordChannelId || eventData?.channelId || eventData?.channel?.id;
  if (expectedChannelId && eventChannelId && expectedChannelId !== eventChannelId) return;
  if (eventData?.author?.isBot || eventData?.author?.isTakaroBot || eventData?.author?.bot || eventData?.isBot || eventData?.bot) return;
  const text = pickText(eventData?.msg, eventData?.message, eventData?.content, eventData?.text);
  if (!text) return;
  const author = pickAuthorName(eventData);
  const message = `[Discord] ${author}: ${text}`;
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message, opts: {} });
  console.log(`discord-7d2d-status: relayed Discord message to game: ${message}`);
}

await main();
