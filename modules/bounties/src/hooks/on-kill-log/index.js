import { data, takaro } from '@takaro/helpers';
import { claimBounty } from './bounty-helpers.js';

/** Finds the player with this exact name who has played on this game server. */
async function findPlayerOnServer(gameServerId, name) {
  const players = (await takaro.player.playerControllerSearch({ filters: { name: [name] }, limit: 10 })).data.data;
  for (const p of players) {
    const pogs = (
      await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [gameServerId], playerId: [p.id] },
      })
    ).data.data;
    if (pogs[0]) return pogs[0];
  }
  return null;
}

async function main() {
  const { gameServerId, eventData, module: mod } = data;
  const pattern = (mod.userConfig && mod.userConfig.killLogPattern) || '';
  const msg = (eventData && eventData.msg) || '';
  if (!pattern || !msg) return;

  let match;
  try {
    match = new RegExp(pattern).exec(msg);
  } catch (err) {
    console.error(`bounties: killLogPattern is not a valid regular expression: ${err}`);
    return;
  }
  if (!match || !match.groups || !match.groups.victim || !match.groups.killer) return;

  const victimName = match.groups.victim.trim();
  const killerName = match.groups.killer.trim();
  if (victimName === killerName) return;

  const [victim, killer] = [await findPlayerOnServer(gameServerId, victimName), await findPlayerOnServer(gameServerId, killerName)];
  if (!victim || !killer) {
    // "killed by" also matches PvE lines on some games; only player-on-player kills count.
    console.log(`bounties: log kill "${killerName}" -> "${victimName}" is not between two known players`);
    return;
  }

  await claimBounty({
    gameServerId,
    mod,
    victimPlayerId: victim.playerId,
    killerPlayerId: killer.playerId,
    killerGameId: killer.gameId,
  });
}

await main();
