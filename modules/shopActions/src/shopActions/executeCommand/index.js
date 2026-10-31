import { takaro, data, TakaroUserError } from '@takaro/helpers';

async function main() {
  const command = data.module.userConfig.executeCommand?.command;

  if (!command) {
    throw new TakaroUserError('No command configured for the executeCommand shop action.');
  }

  await takaro.gameserver.gameServerControllerExecuteCommand(data.gameServerId, {
    command,
  });
}

await main();
