import { data } from '@takaro/helpers';
import {
  BLOOD_STATE_KEY,
  getDiscordChannelFromHook,
  getOnlinePlayers,
  readVariable,
  renderMessage,
  resolveMessage,
  sendDiscord,
} from './discord-7d2d-status-helpers.js';

async function sendPrivateBloodMoonNotice(gameServerId, mod, player) {
  const config = mod.userConfig;
  if (config.privateBloodMoonNoticeOnFirstJoin !== true || !player) return;

  const phase = await readVariable(gameServerId, mod.moduleId, BLOOD_STATE_KEY, null);
  if (typeof phase !== 'string' || (!phase.startsWith('today:') && !phase.startsWith('start:'))) return;

  const { onlinePlayers } = await getOnlinePlayers(gameServerId);
  if (onlinePlayers !== 1) return;

  const message = resolveMessage(config, 'privateBloodMoonTodayMessage');
  await player.pm(message);
  console.log(`discord-7d2d-status: private blood moon first-join notice sent: ${message}`);
}

async function main() {
  const { gameServerId, player, module: mod } = data;
  const config = mod.userConfig;
  await sendPrivateBloodMoonNotice(gameServerId, mod, player);
  if (config.monitorJoins === false) return;
  const channelId = getDiscordChannelFromHook(data, config.monitoringChannelId, 'monitorJoin');
  const playerName = player?.name || resolveMessage(config, 'unknownPlayerText');
  await sendDiscord(channelId, renderMessage(config, 'joinMessageTemplate', { player: playerName }));
}

await main();
