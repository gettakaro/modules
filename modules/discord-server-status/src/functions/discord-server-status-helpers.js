import { takaro } from '@takaro/helpers';
import { buildStatusMessage, trimOrEmpty } from './discord-server-status-pure.js';

export async function fetchOnlinePlayers(gameServerId) {
  let allPlayers = [];
  let page = 0;
  const limit = 100;

  while (true) {
    if (page > 100) {
      throw new Error('discord-server-status: reached pagination safety limit while fetching online players');
    }

    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [gameServerId],
        online: [true],
      },
      page,
      limit,
    });

    const batch = res.data.data ?? [];
    allPlayers = allPlayers.concat(batch);
    const total = res.data.meta?.total;
    if (typeof total === 'number' && allPlayers.length >= total) break;
    if (batch.length < limit) break;
    page += 1;
  }

  const seen = new Set();
  return allPlayers.filter((player) => {
    const id = trimOrEmpty(player?.playerId || player?.id || player?.gameId);
    if (id === '' || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export async function getServerName(gameServerId) {
  try {
    const res = await takaro.gameserver.gameServerControllerGetOne(gameServerId);
    return trimOrEmpty(res.data.data?.name) || 'Unknown Server';
  } catch (err) {
    console.error(`discord-server-status: failed to fetch server name for ${gameServerId}: ${err}`);
    return 'Unknown Server';
  }
}

export function getDiscordChannelId(mod, eventData) {
  return trimOrEmpty(
    mod?.userConfig?.discordChannelId ||
    mod?.systemConfig?.hooks?.discordStatus?.discordChannelId ||
    mod?.systemConfig?.hooks?.DiscordStatus?.discordChannelId ||
    eventData?.discordChannelId ||
    eventData?.channelId,
  );
}

export async function buildCurrentStatus(gameServerId, config) {
  const [serverName, onlinePlayers] = await Promise.all([
    getServerName(gameServerId),
    fetchOnlinePlayers(gameServerId),
  ]);

  return {
    message: buildStatusMessage({ serverName, onlinePlayers, config }),
    onlineCount: onlinePlayers.length,
    serverName,
  };
}

function statusMessageVariableKey(channelId) {
  return `discord-server-status:status-message:${channelId}`;
}

async function getSavedStatusMessage(gameServerId, channelId) {
  const key = statusMessageVariableKey(channelId);
  const res = await takaro.variable.variableControllerSearch({
    filters: { key: [key], gameServerId: [gameServerId] },
    limit: 1,
  });
  const existing = res.data.data?.[0];
  if (!existing) return null;

  return {
    id: existing.id,
    key,
    messageId: trimOrEmpty(existing.value),
  };
}

async function saveStatusMessage(gameServerId, channelId, messageId) {
  const key = statusMessageVariableKey(channelId);
  const existing = await getSavedStatusMessage(gameServerId, channelId);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: messageId });
    return;
  }

  await takaro.variable.variableControllerCreate({
    key,
    value: messageId,
    gameServerId,
  });
}

export async function sendOrUpdateDiscordStatusMessage(gameServerId, channelId, message) {
  const saved = await getSavedStatusMessage(gameServerId, channelId);

  if (saved?.messageId) {
    try {
      const updated = await takaro.discord.discordControllerUpdateMessage(channelId, saved.messageId, { message });
      const updatedMessageId = trimOrEmpty(updated.data.data?.id) || saved.messageId;
      if (updatedMessageId !== saved.messageId) {
        await saveStatusMessage(gameServerId, channelId, updatedMessageId);
      }
      return { action: 'updated', messageId: updatedMessageId };
    } catch (err) {
      console.error(`discord-server-status: failed to update saved Discord status message ${saved.messageId}, posting a replacement: ${err}`);
    }
  }

  const sent = await takaro.discord.discordControllerSendMessage(channelId, { message });
  const messageId = trimOrEmpty(sent.data.data?.id);
  if (messageId) {
    await saveStatusMessage(gameServerId, channelId, messageId);
  }
  return { action: 'sent', messageId };
}
