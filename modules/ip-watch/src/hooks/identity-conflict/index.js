import { takaro, data } from '@takaro/helpers';
import { isExempt, sendAlert } from './ip-watch-helpers.js';

async function playerName(playerId) {
  try {
    const res = await takaro.player.playerControllerGetOne(playerId);
    return res.data.data.name || playerId;
  } catch {
    return playerId;
  }
}

async function main() {
  const { gameServerId, player, pog, eventData, module: mod } = data;
  const config = mod.userConfig;

  if (!config.identityConflictAlert) {
    console.log('ip-watch: identity conflict alerts are off');
    return;
  }
  if (player && isExempt(player, pog, config)) {
    console.log(`ip-watch: ${player.name} is exempt, skipping`);
    return;
  }

  const keptId = (eventData && eventData.keptPlayerId) || (player && player.id);
  const matched = Array.isArray(eventData && eventData.matchedPlayers) ? eventData.matchedPlayers : [];
  const others = matched.filter((m) => m && m.playerId && m.playerId !== keptId);

  const keptName = player && player.id === keptId ? player.name : keptId ? await playerName(keptId) : 'unknown player';
  const parts = [];
  for (const other of others) {
    const name = await playerName(other.playerId);
    const on = Array.isArray(other.matchedOn) && other.matchedOn.length > 0 ? ` (on ${other.matchedOn.join(', ')})` : '';
    parts.push(`${name}${on}`);
  }

  const detail = parts.length > 0 ? ` also matches ${parts.join(', ')}` : ' matches more than one player record';
  await sendAlert(gameServerId, config, `Identity conflict: ${keptName}${detail}. Possible alt or shared account.`);
}

await main();
