import { data, TakaroUserError } from '@takaro/helpers';
import { incomingRequests, pickRequest, deleteRequest, fulfil, prefix } from './tpa.js';

async function main() {
  const { pog, arguments: args } = data;
  const requests = await incomingRequests(pog.playerId);
  if (requests.length === 0) {
    throw new TakaroUserError('You have no pending teleport requests.');
  }
  const request = pickRequest(requests, args.player);

  // Consume the request first, so a double tpaccept cannot teleport twice.
  await deleteRequest(request);
  await fulfil(request);

  const left = requests.length - 1;
  if (left > 0) {
    const p = await prefix();
    await data.player.pm(`You have ${left} more request(s). Type ${p}tpaccept <name> or ${p}tpdeny <name>.`);
  }
}

await main();
