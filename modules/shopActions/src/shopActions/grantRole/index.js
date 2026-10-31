import { takaro, data, TakaroUserError } from '@takaro/helpers';

async function main() {
  const roleId = data.module.userConfig.grantRole?.roleId;

  if (!roleId) {
    throw new TakaroUserError('No roleId configured for the grantRole shop action.');
  }

  if (!data.player) {
    throw new TakaroUserError('Player data is not available for this shop action.');
  }

  await takaro.player.playerControllerAssignRole(data.player.id, roleId, {
    gameServerId: data.gameServerId,
  });

  await data.player.pm(`You have been granted a new role!`);
}

await main();
