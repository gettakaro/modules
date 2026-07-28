/**
 * Pure helpers for discord-server-status. No @takaro/helpers imports so tests can
 * exercise the exact formatting logic without a Takaro sandbox.
 */

export function trimOrEmpty(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

export function normalizeTriggers(value) {
  const source = Array.isArray(value) && value.length > 0 ? value : ['!status', '!serverstatus', '!players'];
  return [...new Set(source
    .map((trigger) => trimOrEmpty(trigger).toLowerCase())
    .filter((trigger) => trigger !== ''))];
}

export function getPlayerDisplayName(player) {
  return trimOrEmpty(player?.name || player?.playerName || player?.gameId || player?.playerId || player?.id || 'Unknown Player');
}

export function formatPlayerList(players, { includePlayerNames = true, maxPlayerNames = 10 } = {}) {
  const onlinePlayers = Array.isArray(players) ? players : [];
  if (!includePlayerNames || maxPlayerNames <= 0 || onlinePlayers.length === 0) return '';

  const names = onlinePlayers
    .map((player) => getPlayerDisplayName(player))
    .filter((name) => name !== '')
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  const visible = names.slice(0, maxPlayerNames);
  const hiddenCount = Math.max(0, names.length - visible.length);
  const suffix = hiddenCount > 0 ? `, +${hiddenCount} more` : '';
  return `${visible.join(', ')}${suffix}`;
}

export function renderTemplate(template, placeholders) {
  const source = trimOrEmpty(template) || '{serverName}: {onlineCount} {playerNoun} online. {playerListText}';
  return source.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(placeholders, key)) {
      return String(placeholders[key]);
    }
    return `{${key}}`;
  }).replace(/\s+/g, ' ').trim();
}

export function buildStatusMessage({
  serverName = 'Unknown Server',
  onlinePlayers = [],
  config = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const players = Array.isArray(onlinePlayers) ? onlinePlayers : [];
  const onlineCount = players.length;
  const includePlayerNames = config.includePlayerNames !== false;
  const maxPlayerNames = Number.isInteger(config.maxPlayerNames) ? config.maxPlayerNames : 10;
  const playerList = formatPlayerList(players, { includePlayerNames, maxPlayerNames });
  const emptyText = trimOrEmpty(config.emptyPlayerListText) || 'Nobody is online right now.';
  const prefix = config.playerListPrefix === undefined || config.playerListPrefix === null
    ? 'Players: '
    : String(config.playerListPrefix);
  const playerListText = playerList === '' ? emptyText : `${prefix}${playerList}`;
  const playerNoun = onlineCount === 1 ? 'player' : 'players';

  return renderTemplate(config.statusTemplate, {
    serverName: trimOrEmpty(serverName) || 'Unknown Server',
    onlineCount,
    playerNoun,
    playerList,
    playerListText,
    generatedAt,
  });
}
