import { data, takaro } from '@takaro/helpers';
import { buildCurrentStatus, getDiscordChannelId } from './discord-server-status-helpers.js';
import { normalizeTriggers, trimOrEmpty } from './discord-server-status-pure.js';

async function main() {
  const { gameServerId, module: mod, eventData } = data;
  const config = mod.userConfig ?? {};

  if (eventData?.author?.isBot) return;

  const message = trimOrEmpty(eventData?.msg || eventData?.message || eventData?.content).toLowerCase();
  const triggers = normalizeTriggers(config.discordTriggers);
  if (!triggers.includes(message)) return;

  const discordChannelId = getDiscordChannelId(mod, eventData);
  if (!discordChannelId) {
    console.warn('discord-server-status: trigger matched but no Discord channel ID was available');
    return;
  }

  const result = await buildCurrentStatus(gameServerId, config);
  await takaro.discord.discordControllerSendMessage(discordChannelId, { message: result.message });
  console.log(`discord-server-status: Discord reply sent, server=${result.serverName}, online=${result.onlineCount}`);
}

await main();
