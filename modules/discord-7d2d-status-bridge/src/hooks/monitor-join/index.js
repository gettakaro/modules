import { data } from '@takaro/helpers';
import { getDiscordChannelFromHook, renderMessage, resolveMessage, sendDiscord } from './discord-7d2d-status-helpers.js';

async function main() {
  const { player, module: mod } = data;
  const config = mod.userConfig;
  if (config.monitorJoins === false) return;
  const channelId = getDiscordChannelFromHook(data, config.monitoringChannelId, 'monitorJoin');
  const playerName = player?.name || resolveMessage(config, 'unknownPlayerText');
  await sendDiscord(channelId, renderMessage(config, 'joinMessageTemplate', { player: playerName }));
}

await main();
