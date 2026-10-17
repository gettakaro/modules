import { data } from '@takaro/helpers';
import { getDiscordChannelFromHook, getServerName, renderMessage, sendDiscord } from './discord-7d2d-status-helpers.js';

async function main() {
  const { eventData, gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const status = String(eventData?.status ?? '').toLowerCase();
  const messageKey = status === 'online'
    ? 'serverStartingMessageTemplate'
    : status === 'offline'
      ? 'serverOfflineMessageTemplate'
      : null;

  if (!messageKey) {
    console.log(`discord-7d2d-status: ignoring unsupported server status: ${status || 'missing'}`);
    return;
  }

  const channelId = getDiscordChannelFromHook(data, config.monitoringChannelId, 'monitorServerStatus');
  const serverName = await getServerName(gameServerId);
  await sendDiscord(channelId, renderMessage(config, messageKey, { serverName }));
}

await main();
