import { data, takaro } from '@takaro/helpers';
import { buildCurrentStatus, getDiscordChannelId } from './discord-server-status-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig ?? {};
  const discordChannelId = getDiscordChannelId(mod);

  if (!discordChannelId) {
    console.log('discord-server-status: no discordChannelId configured, skipping scheduled status post');
    return;
  }

  const result = await buildCurrentStatus(gameServerId, config);
  if (result.onlineCount === 0 && config.sendCronWhenEmpty === false) {
    console.log('discord-server-status: no players online and sendCronWhenEmpty=false, skipping scheduled status post');
    return;
  }

  await takaro.discord.discordControllerSendMessage(discordChannelId, { message: result.message });
  console.log(`discord-server-status: scheduled Discord status sent, server=${result.serverName}, online=${result.onlineCount}`);
}

await main();
