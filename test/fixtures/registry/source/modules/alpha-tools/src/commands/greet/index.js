import { data, takaro } from '@takaro/helpers';

async function main() {
  const { gameServerId, arguments: args } = data;
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message: `Hello ${args.player.name}` });
}

await main();
