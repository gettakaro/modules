import { data } from '@takaro/helpers';
import { getDiscordChannelFromHook, isDiscordRelayEcho, isGlobalChatMessage, pickText, sendDiscord } from './discord-7d2d-status-helpers.js';

async function main() {
  const { eventData, player, module: mod } = data;
  const config = mod.userConfig;
  if (config.relayGameToDiscord === false) return;
  if (!isGlobalChatMessage(eventData)) return;
  if (isDiscordRelayEcho(eventData)) return;
  const channelId = getDiscordChannelFromHook(data, config.chatChannelId, 'gameChatRelay');
  const text = pickText(eventData?.msg, eventData?.message, eventData?.text, eventData?.chatMessage?.message);
  if (!text) return;
  const name = player?.name || eventData?.player?.name || 'Game';
  await sendDiscord(channelId, `**${name}:** ${text}`);
}

await main();
