import { data } from '@takaro/helpers';
import { getDiscordChannelFromHook, pickText, renderMessage, resolveMessage, sendDiscord } from './discord-7d2d-status-helpers.js';

async function main() {
  const { eventData, player, module: mod } = data;
  const config = mod.userConfig;
  if (config.monitorDeaths === false) return;
  const channelId = getDiscordChannelFromHook(data, config.monitoringChannelId, 'monitorDeath');
  const reason = pickText(eventData?.reason, eventData?.cause, eventData?.message);
  const victim = player?.name || eventData?.player?.name || resolveMessage(config, 'unknownPlayerText');
  const key = reason ? 'deathWithReasonMessageTemplate' : 'deathMessageTemplate';
  await sendDiscord(channelId, renderMessage(config, key, { player: victim, reason }));
}

await main();
