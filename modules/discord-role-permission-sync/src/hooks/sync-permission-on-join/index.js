import { data, takaro } from '@takaro/helpers';
import {
  getPlayerGameId,
  getRoleNames,
  renderMessage,
  renderTemplate,
  selectPermissionForRoles,
} from './permission-sync-helpers.js';

async function main() {
  const { gameServerId, player, module: mod } = data;
  const config = mod.userConfig || {};

  if (config.enabled === false) {
    console.log('discordRolePermissionSync: disabled by config');
    return;
  }

  const pog = (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, player.id)).data.data;
  const roleNames = getRoleNames(pog);
  const selection = selectPermissionForRoles(roleNames, config);

  if (selection.permissionLevel === null) {
    console.log(`discordRolePermissionSync: player=${player.name} roles=[${roleNames.join(', ')}] did not match a role and no unmatchedPermissionLevel is configured`);
    if (config.notifyUnmatchedDiscordLink) {
      await pog.pm(config.unmatchedMessage || 'No reserved-slot role was found for you. If you are a supporter, make sure your Discord account is linked.');
    }
    return;
  }

  const playerGameId = getPlayerGameId(player, pog);
  if (!playerGameId) {
    console.error(`discordRolePermissionSync: player=${player.name} has no gameId/name usable in console command`);
    return;
  }

  const context = {
    playerGameId,
    playerName: player.name,
    permissionLevel: selection.permissionLevel,
    matchedRole: selection.matchedRole,
  };
  const command = renderTemplate(config.commandTemplate || 'admin add {playerGameId} {permissionLevel}', context);

  if (config.dryRun) {
    console.log(`discordRolePermissionSync: dryRun player=${player.name} matched=${selection.matched} role=${selection.matchedRole || 'unmatched'} command=${command}`);
  } else {
    await takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, { command });
    console.log(`discordRolePermissionSync: applied permissionLevel=${selection.permissionLevel} to player=${player.name} matchedRole=${selection.matchedRole || 'unmatched'}`);
  }

  if (config.notifyPlayer && selection.matched) {
    await pog.pm(renderMessage(config.matchedMessage || 'Your reserved-slot permission has been synced.', context));
  } else if (config.notifyUnmatchedDiscordLink && !selection.matched) {
    await pog.pm(renderMessage(config.unmatchedMessage || 'No reserved-slot role was found for you. If you are a supporter, make sure your Discord account is linked.', context));
  }
}

await main();
