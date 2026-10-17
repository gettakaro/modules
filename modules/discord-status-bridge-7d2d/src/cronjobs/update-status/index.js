import { data } from '@takaro/helpers';
import { getStatus, getDiscordChannelFromHook, renderTemplate, sendDiscord, updatePersistentDiscordMessage } from './discord-7d2d-status-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const channelId = getDiscordChannelFromHook(data, config.monitoringChannelId, 'updateStatus');
  const status = await getStatus(gameServerId, config);
  const message = renderTemplate(config.statusTemplate, status, config);
  if (config.updateStatusMessage ?? true) await updatePersistentDiscordMessage(gameServerId, mod.moduleId, channelId, message);
  else await sendDiscord(channelId, message);
}

await main();
