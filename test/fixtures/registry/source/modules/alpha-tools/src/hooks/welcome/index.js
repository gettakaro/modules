import { data, takaro } from '@takaro/helpers';

async function main() {
  const { gameServerId, player } = data;
  await takaro.gameserver.gameServerControllerGiveItem(gameServerId, player.id, { name: 'bread', amount: 1 });
}

await main();
