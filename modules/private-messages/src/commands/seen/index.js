import { data, TakaroUserError, takaro } from '@takaro/helpers';
import { formatAgo, getPlayerName } from './pm-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args } = data;
  const target = args.player;
  if (!target || !target.playerId) throw new TakaroUserError('Please name a player.');
  if (target.playerId === player.id) {
    await pog.pm('You are right here.');
    return;
  }

  const [name, res] = await Promise.all([
    getPlayerName(target.playerId, target.name || 'That player'),
    takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, target.playerId),
  ]);
  const tPog = res.data.data;
  if (tPog.online) {
    await pog.pm(`${name} is online right now.`);
    return;
  }
  const lastSeen = tPog.lastSeen ? new Date(tPog.lastSeen) : null;
  if (!lastSeen || Number.isNaN(lastSeen.getTime())) {
    await pog.pm(`${name} has not been seen on this server yet.`);
    return;
  }
  const stamp = lastSeen.toISOString().slice(0, 16).replace('T', ' ');
  await pog.pm(`${name} was last seen ${formatAgo(Date.now() - lastSeen.getTime())} (${stamp} UTC).`);
}

await main();
