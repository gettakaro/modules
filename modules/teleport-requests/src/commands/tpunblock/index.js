import { data, TakaroUserError } from '@takaro/helpers';
import { readBlocks, writeBlocks, playerName } from './tpa.js';

async function main() {
  const { pog, arguments: args } = data;
  const other = args.player;
  const { row, list } = await readBlocks(pog.playerId);
  const name = list.find((b) => b.id === other.playerId)?.name ?? (await playerName(other.playerId));
  if (!list.some((b) => b.id === other.playerId)) {
    throw new TakaroUserError(`${name} is not blocked.`);
  }
  await writeBlocks(pog.playerId, row, list.filter((b) => b.id !== other.playerId));
  await data.player.pm(`${name} can send you teleport requests again.`);
}

await main();
