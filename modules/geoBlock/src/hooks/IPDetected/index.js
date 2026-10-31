import { takaro, data, checkPermission } from '@takaro/helpers';

async function main() {
  const { gameServerId, player, pog } = data;
  const { country } = data.eventData;
  const { ban, banDuration, countries, message, mode } = data.module.userConfig;

  async function handleAction() {
    if (ban) {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + banDuration);
      await takaro.player.banControllerCreate({
        gameServerId,
        playerId: player.id,
        until: expiresAt,
        reason: message,
      });
    } else {
      await takaro.gameserver.gameServerControllerKickPlayer(gameServerId, player.id, {
        reason: message,
      });
    }
  }

  const isImmune = checkPermission(pog, 'GEOBLOCK_IMMUNITY');
  if (isImmune) {
    console.log('Player has immunity, no action');
    return;
  }

  if (mode === 'allow') {
    if (countries.includes(country)) {
      console.log('Allowed country detected, no action');
      return;
    }
    console.log('Blocked country detected, performing actions');
    await handleAction();
    return;
  }

  if (mode === 'deny') {
    if (countries.includes(country)) {
      console.log('Blocked country detected, performing actions');
      await handleAction();
      return;
    }
      console.log('Allowed country detected, no action');
    
  }
}

await main();
