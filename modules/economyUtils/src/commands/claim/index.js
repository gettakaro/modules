import { takaro, data, TakaroUserError } from '@takaro/helpers';

async function searchOrders(filters) {
  const res = await takaro.shopOrder.shopOrderControllerSearch({
    filters,
    sortBy: 'createdAt',
    sortDirection: 'asc',
  });
  return res.data.data;
}

async function main() {
  const { user, player, arguments: args, gameServerId } = data;

  if (!user) {
    throw new TakaroUserError('You must link your account to Takaro to use this command.');
  }

  const scope = { userId: [user.id] };

  // Only filter by gameServerId if it's available (should always be present in command context)
  if (gameServerId) {
    scope.gameServerId = [gameServerId];
  }

  // Paid orders first, then claimed ones whose items definitively could not be handed over
  // (claiming one again retries the delivery), each oldest first. A failed delivery that keeps
  // failing must not stand in front of an order that was never claimed.
  const paid = await searchOrders({ ...scope, status: ['PAID'] });
  const failedDelivery = await searchOrders({ ...scope, status: ['COMPLETED'], deliveryStatus: ['FAILED'] });
  const pendingOrders = [...paid, ...failedDelivery];

  if (pendingOrders.length === 0) {
    await player.pm('You have no pending orders.');
    return;
  }

  let claimedAny = false;
  for (const order of pendingOrders) {
    let claimed;
    try {
      claimed = (await takaro.shopOrder.shopOrderControllerClaim(order.id)).data.data;
    } catch (error) {
      // A failed delivery can become unclaimable (its listing was removed or unpublished). It
      // must not block the orders behind it, so it is skipped; a paid order's refusal is not.
      if (order.status === 'PAID') {
        throw error;
      }
      continue;
    }
    claimedAny = true;
    if (claimed.deliveryStatus === 'FAILED') {
      await player.pm('The items of an order could not be handed over. Use /claim to try again.');
    } else if (claimed.deliveryStatus === 'UNKNOWN') {
      await player.pm('The delivery of an order could not be confirmed. Ask an admin to check it.');
    }
    if (!args.all) {
      break;
    }
  }

  if (!claimedAny) {
    await player.pm('None of your pending orders can be claimed right now. Ask an admin to check them.');
  }
}

await main();
