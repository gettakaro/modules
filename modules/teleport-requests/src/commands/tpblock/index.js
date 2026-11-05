import { data, TakaroUserError } from '@takaro/helpers';
import { readBlocks, writeBlocks, incomingRequests, deleteRequest, playerName } from './tpa.js';

const MAX_BLOCKS = 100;

async function main() {
  const { pog, arguments: args } = data;
  const other = args.player;
  if (other.playerId === pog.playerId) {
    throw new TakaroUserError('You cannot block yourself.');
  }
  const name = await playerName(other.playerId);
  const { row, list } = await readBlocks(pog.playerId);
  if (list.some((b) => b.id === other.playerId)) {
    throw new TakaroUserError(`${name} is already blocked.`);
  }
  if (list.length >= MAX_BLOCKS) {
    throw new TakaroUserError(`You can block at most ${MAX_BLOCKS} players.`);
  }
  await writeBlocks(pog.playerId, row, [...list, { id: other.playerId, name }]);

  // Drop a request this player already sent.
  const pending = (await incomingRequests(pog.playerId)).filter((r) => r.requesterId === other.playerId);
  await Promise.all(pending.map(deleteRequest));

  await data.player.pm(`Blocked teleport requests from ${name}.`);
}

await main();
