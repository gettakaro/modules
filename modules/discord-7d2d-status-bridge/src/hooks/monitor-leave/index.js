import { data } from '@takaro/helpers';
import { getDiscordChannelFromHook, sendDiscord } from './discord-7d2d-status-helpers.js';

async function main() {
  const { player, module: mod } = data;
  const config = mod.userConfig;
  if (config.monitorLeaves === false) return;
  const channelId = getDiscordChannelFromHook(data, config.monitoringChannelId, 'monitorLeave');
  await sendDiscord(channelId, `👋 ${player?.name || 'Player'} opuścił serwer.`);
}

await main();
