import { data, TakaroUserError } from '@takaro/helpers';
import { outgoingRequest, deleteRequest, freshPog, tell } from './tpa.js';

async function main() {
  const { pog, player } = data;
  const request = await outgoingRequest(pog.playerId);
  if (!request) {
    throw new TakaroUserError('You have no open teleport request.');
  }
  await deleteRequest(request);

  const target = await freshPog(request.targetId);
  if (target.online) {
    await tell(target.gameId, `${player.name} cancelled their teleport request.`);
  }
  await data.player.pm(`Cancelled your request to ${request.targetName}.`);
}

await main();
