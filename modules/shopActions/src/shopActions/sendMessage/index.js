import { takaro, data } from '@takaro/helpers';

async function main() {
  const config = data.module.userConfig.sendMessage || {};
  const message = config.message || 'Thank you for your purchase!';
  const broadcast = config.broadcast || false;

  if (broadcast) {
    await takaro.gameserver.gameServerControllerSendMessage(data.gameServerId, {
      message,
    });
  } else {
    if (!data.player) {
      return;
    }
    await data.player.pm(message);
  }
}

await main();
