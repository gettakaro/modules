import { takaro, data, TakaroUserError } from '@takaro/helpers';

// The six operator phrases of a listing's variable purchase restriction (GH #2522), restated here
// because a module cannot import from app-api. Only the PHRASING is copied: this command never
// evaluates the requirement, it only prints it - the refusal still comes from the server.
const REQUIREMENT_PHRASES = {
  gte: 'at least',
  gt: 'more than',
  lte: 'at most',
  lt: 'less than',
  eq: 'exactly',
  ne: 'not',
};

// oxlint-disable-next-line sonarjs/cognitive-complexity -- GH #4103
async function main() {
  const { arguments: args, player, gameServerId } = data;
  const { page, item, action } = args;
  const prefix = (await takaro.settings.settingsControllerGetOne('commandPrefix', gameServerId)).data.data.value;

  // If command is called without any arguments
  const messageWithoutPrefix = data.chatMessage.msg.slice(prefix.length).trim();
  if (!messageWithoutPrefix.includes(' ')) {
    await player.pm('This command allows you to browse the shop and view available items.');
    await player.pm(`Usage: ${prefix}shop [page] [item] [action]`);
    await player.pm(`${prefix}shop 2 - View the second page of shop items`);
    await player.pm(`${prefix}shop 1 3 - View details about the third item on the first page`);
    await player.pm(`${prefix}shop 1 3 buy - Purchase the third item on the first page`);
    return;
  }

  const shopItems = await takaro.shopListing.shopListingControllerSearch({
    limit: 5,
    page: page - 1,
    sortBy: 'name',
    sortDirection: 'asc',
    filters: {
      gameServerId: [gameServerId],
      draft: false,
    },
  });

  if (shopItems.data.data.length === 0) {
    await player.pm('No items found.');
    return;
  }

  const currencyName = (await takaro.settings.settingsControllerGetOne('currencyName', data.gameServerId)).data.data;

  if (!item) {
    // List the shop items with index
    let index = 1;
    for (const listing of shopItems.data.data) {
      const items = listing.items.slice(0, 3).map((item) => {
        return `${item.amount}x ${item.item.name}`;
      });
      // GH #2520 - a finite stock is shown so a player can see what is left before buying.
      const stockNote = listing.stock === null || listing.stock === undefined ? '' : ` (${listing.stock} left)`;
      await player.pm(
        `${index} - ${listing.name} - ${listing.price} ${currencyName.value}${stockNote}. ${items.join(', ')}`,
      );
      index++;
    }
    return;
  }

  const selectedItem = shopItems.data.data[item - 1];
  if (!selectedItem) {
    throw new TakaroUserError(
      `Item not found. Please select an item from the list, valid options are 1-${shopItems.data.data.length}.`,
    );
  }

  if (action === 'none') {
    // Display more info about the item
    await player.pm(`Listing ${selectedItem.name} - ${selectedItem.price} ${currencyName.value}`);
    if (selectedItem.requiredVariableKey) {
      const phrase = REQUIREMENT_PHRASES[selectedItem.requiredVariableOperator];
      await player.pm(
        `Requires ${selectedItem.requiredVariableKey} ${phrase} ${selectedItem.requiredVariableThreshold}.`,
      );
    }
    await Promise.all(
      selectedItem.items.map((item) => {
        const quality = item.quality ? `Quality: ${item.quality}` : '';
        const description = (item.item.description ? `Description: ${item.item.description}` : '').replaceAll(
          '\\n',
          ' ',
        );

        return player.pm(`- ${item.amount}x ${item.item.name}. ${quality} ${description}`);
      }),
    );
    return;
  }

  if (action === 'buy') {
    // Only a TakaroUserError reaches the player - anything else is shown as the generic
    // "Oops, something went wrong". A refusal (GH #2520, GH #2522) is always a 400 carrying the
    // reason, so translate that one status and let everything else rethrow: a 500's internals are
    // not game chat, and a bug should look like a bug.
    let orderRes;
    try {
      orderRes = await takaro.shopOrder.shopOrderControllerCreate({
        amount: 1,
        listingId: selectedItem.id,
        playerId: player.id,
      });
    } catch (error) {
      const apiMessage = error.response?.status === 400 ? error.response?.data?.meta?.error?.message : null;
      if (!apiMessage) {
        throw error;
      }
      throw new TakaroUserError(apiMessage);
    }

    // An instant listing comes back already COMPLETED; anything else still has to be claimed.
    // Only a COMPLETED order whose items were confirmed (or that had none) is a purchase to report.
    // The money is gone and the order stands either way, so buying again is never the advice.
    const pending = `Your purchase of ${selectedItem.name} went through, but it could not be handed over yet. Use /claim once you are in game to receive it.`;
    let order = orderRes.data.data;
    if (order.status === 'PAID') {
      try {
        order = (await takaro.shopOrder.shopOrderControllerClaim(order.id)).data.data;
      } catch {
        await player.pm(pending);
        return;
      }
    }

    if (order.status === 'COMPLETED' && order.deliveryStatus === 'UNKNOWN') {
      await player.pm(
        `Your purchase of ${selectedItem.name} went through, but Takaro could not confirm the items were handed over. Ask an admin to check it, and do not buy it again.`,
      );
      return;
    }
    if (
      order.status !== 'COMPLETED' ||
      (order.deliveryStatus !== 'DELIVERED' && order.deliveryStatus !== 'NOT_APPLICABLE')
    ) {
      await player.pm(pending);
      return;
    }

    await player.pm(`You have purchased ${selectedItem.name} for ${selectedItem.price} ${currencyName.value}.`);
    return;
  }

  throw new TakaroUserError('Invalid action. Valid actions are "buy".');
}

await main();
