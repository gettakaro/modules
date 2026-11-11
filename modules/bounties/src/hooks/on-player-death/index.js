import { data, takaro } from '@takaro/helpers';
import { claimBounty } from './bounty-helpers.js';

async function main() {
  const { gameServerId, eventData, player, module: mod } = data;

  const attacker = eventData && eventData.attacker;
  if (!player || !attacker || !attacker.gameId) {
    // Most deaths are PvE. Some games (7 Days to Die) never send the attacker here; the log hook covers them.
    console.log('bounties: player-death without a player attacker, nothing to claim');
    return;
  }
  if (attacker.gameId === (eventData.player && eventData.player.gameId)) {
    console.log('bounties: self-kill, nothing to claim');
    return;
  }

  const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: { gameServerId: [gameServerId], gameId: [attacker.gameId] },
  });
  const killerPog = res.data.data[0];
  if (!killerPog) {
    console.log(`bounties: attacker ${attacker.gameId} is not a known player on this server`);
    return;
  }

  await claimBounty({
    gameServerId,
    mod,
    victimPlayerId: player.id,
    killerPlayerId: killerPog.playerId,
    killerGameId: attacker.gameId,
  });
}

await main();
