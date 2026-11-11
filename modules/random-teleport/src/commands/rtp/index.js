import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';
import {
  BYPASS_COOLDOWN_PERMISSION,
  requireUse,
  readArea,
  findSpot,
  cooldownLeft,
  startCooldown,
  formatDuration,
  freshPog,
  currencyName,
  teleport,
} from './rtp.js';

async function main() {
  requireUse();
  const { pog, gameServerId } = data;
  const config = data.module.userConfig;
  const cost = config.cost ?? 0;
  readArea(config);

  const bypassCooldown = Boolean(checkPermission(pog, BYPASS_COOLDOWN_PERMISSION));
  if (!bypassCooldown) {
    const left = await cooldownLeft(pog.playerId);
    if (left > 0) {
      throw new TakaroUserError(`You can random teleport again in ${formatDuration(left)}.`);
    }
  }

  // Re-read the player: with a command delay (warmup) they may have left or spent their money meanwhile.
  const current = await freshPog(pog.playerId);
  if (current.online === false) {
    throw new TakaroUserError('You are no longer online.');
  }
  const coin = cost > 0 ? await currencyName() : '';
  if (cost > 0 && (current.currency ?? 0) < cost) {
    throw new TakaroUserError(`A random teleport costs ${cost} ${coin} and you have ${current.currency ?? 0}.`);
  }

  const spot = findSpot(config, Math.random);
  if (!spot) {
    throw new TakaroUserError('Could not find a free spot this time. Please try again. You were not charged.');
  }

  const destination = { x: spot.x, y: config.y ?? 0, z: spot.z };
  if (current.dimension) {
    destination.dimension = current.dimension;
  }
  await teleport(pog.playerId, destination);

  if (cost > 0) {
    await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, pog.playerId, {
      currency: cost,
    });
  }
  if (!bypassCooldown) {
    await startCooldown(pog.playerId, config.cooldown ?? 0);
  }

  const paid = cost > 0 ? ` (-${cost} ${coin})` : '';
  await data.player.pm(`Teleported to a random spot at ${spot.x}, ${spot.z}${paid}.`);
}

await main();
