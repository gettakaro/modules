import { takaro, data, TakaroUserError } from '@takaro/helpers';
import { getCrates, getPrefix, addKeys, claimOrder } from './crate-helpers.js';

/** The crate whose name appears in the listing name; the longest name wins ("gold" over "go"). */
function crateForListing(config, listingName) {
  const text = String(listingName || '').toLowerCase();
  const matches = getCrates(config)
    .filter((crate) => {
      const name = String(crate.name).toLowerCase();
      return new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text);
    })
    .sort((a, b) => String(b.name).length - String(a.name).length);
  return matches[0] || null;
}

/** "5x Gold key" or "5 x Gold key" gives packs of 5. */
function packSize(listingName) {
  const match = String(listingName || '').match(/^\s*(\d+)\s*x\b/i);
  const size = match ? parseInt(match[1], 10) : 1;
  return size > 0 ? size : 1;
}

async function main() {
  const { gameServerId, player, orderId, module: mod } = data;
  if (!player) {
    throw new TakaroUserError('Player data is not available for this shop action.');
  }

  const order = (await takaro.shopOrder.shopOrderControllerSearch({ filters: { id: [orderId] }, extend: ['listing'] })).data.data[0];
  if (!order) {
    throw new TakaroUserError(`Shop order ${orderId} was not found.`);
  }
  let listing = order.listing;
  if (!listing || !listing.name) {
    listing = (await takaro.shopListing.shopListingControllerSearch({ filters: { id: [order.listingId] } })).data.data[0];
  }
  if (!listing) {
    throw new TakaroUserError(`The shop listing of order ${orderId} was not found.`);
  }

  const crate = crateForListing(mod.userConfig, listing.name);
  if (!crate) {
    throw new TakaroUserError(
      `The shop listing "${listing.name}" does not name a crate. Rename it to include one of: ${getCrates(mod.userConfig)
        .map((c) => c.name)
        .join(', ')}.`,
    );
  }

  if (!(await claimOrder(orderId, gameServerId, player.id, mod.moduleId))) {
    console.log(`loot-crates: order ${orderId} already gave its keys, skipping.`);
    return;
  }

  const amount = packSize(listing.name) * (Number(order.amount) > 0 ? Number(order.amount) : 1);
  const keys = await addKeys(crate, gameServerId, player.id, mod.moduleId, amount);
  const prefix = await getPrefix(gameServerId);
  try {
    await player.pm(
      `You received ${amount} ${crate.name} crate key(s)! You have ${keys}. Open with ${prefix}crate open ${crate.name}`,
    );
  } catch (error) {
    console.log(`loot-crates: could not message the buyer (offline?): ${error}`);
  }
}

await main();
