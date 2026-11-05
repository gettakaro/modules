import { data, TakaroUserError } from '@takaro/helpers';
import { incomingRequests, pickRequest, deleteRequest, freshPog, tell } from './tpa.js';

async function main() {
  const { pog, player, arguments: args } = data;
  const requests = await incomingRequests(pog.playerId);
  if (requests.length === 0) {
    throw new TakaroUserError('You have no pending teleport requests.');
  }
  const request = pickRequest(requests, args.player);
  await deleteRequest(request);

  const requester = await freshPog(request.requesterId);
  if (requester.online) {
    await tell(requester.gameId, `${player.name} denied your teleport request.`);
  }
  await data.player.pm(`Denied the request from ${request.requesterName}.`);
}

await main();
