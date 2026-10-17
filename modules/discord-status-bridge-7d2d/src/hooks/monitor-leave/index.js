import { data } from '@takaro/helpers';
import { getDiscordChannelFromHook, renderMessage, resolveMessage, sendDiscord } from './discord-7d2d-status-helpers.js';

async function main() {
  const { player, module: mod } = data;
  const config = mod.userConfig;
  if (config.monitorLeaves === false) return;
  const channelId = getDiscordChannelFromHook(data, config.monitoringChannelId, 'monitorLeave');
  const playerName = player?.name || resolveMessage(config, 'unknownPlayerText');
  await sendDiscord(channelId, renderMessage(config, 'leaveMessageTemplate', { player: playerName }));
}

await main();
