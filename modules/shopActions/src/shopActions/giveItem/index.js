import { takaro, data, TakaroUserError } from '@takaro/helpers';

const SET_MISSING =
  'The item set configured for the giveItem shop action no longer exists. Reconfigure the shopActions module.';

function list(lines) {
  return lines.map((line) => `${line.name} x${line.amount}`).join(', ');
}

async function readSet(setId) {
  let res;
  try {
    res = await takaro.itemSet.itemSetControllerGetOne(setId);
  } catch (error) {
    const status = error.response?.status;
    if (status === 404 || status === 400) {
      throw new TakaroUserError(SET_MISSING);
    }
    throw error;
  }
  const set = res.data.data;
  if (set.gameServerId !== data.gameServerId) {
    throw new TakaroUserError(SET_MISSING);
  }
  if (set.lines.length === 0) {
    throw new TakaroUserError('The item set configured for the giveItem shop action has no items.');
  }
  return set;
}

async function giveLines(set) {
  const lines = set.lines.map((line) => ({
    itemId: line.itemId,
    amount: line.amount,
    ...(line.quality ? { quality: line.quality } : {}),
  }));
  try {
    const res = await takaro.gameserver.gameServerControllerGiveItems(data.gameServerId, data.player.id, { lines });
    return res.data.data.lines;
  } catch (error) {
    if (error.response?.status === 400) {
      const reason = error.response.data?.meta?.error?.message ?? 'the server refused it';
      throw new TakaroUserError(`The giveItem shop action could not give the item set: ${reason}`);
    }
    throw error;
  }
}

async function main() {
  const setId = data.module.userConfig.giveItem?.itemSet;

  if (!setId) {
    throw new TakaroUserError('No item set configured for the giveItem shop action.');
  }

  if (!data.player) {
    throw new TakaroUserError('Player data is not available for this shop action.');
  }

  const set = await readSet(setId);
  const results = await giveLines(set);
  const delivered = results.filter((line) => line.result === 'DELIVERED');
  const failed = results.filter((line) => line.result === 'FAILED');
  const unknown = results.filter((line) => line.result === 'UNKNOWN');
  const total = results.length;

  if (failed.length === total) {
    await data.player.pm(
      `Your bonus items could not be given: ${list(failed)}. Please contact a server administrator.`,
    );
    throw new TakaroUserError(`The giveItem shop action could not give any item: ${list(failed)}`);
  }

  if (delivered.length === total) {
    await data.player.pm(`You received ${total} bonus item(s) from your purchase!`);
    return;
  }

  let message = `You received ${delivered.length} of ${total} bonus item(s) from your purchase.`;
  if (failed.length > 0) {
    message += ` These could not be given: ${list(failed)}.`;
  }
  if (unknown.length > 0) {
    message += ` These may not have arrived: ${list(unknown)}.`;
  }
  message += ' Please contact a server administrator.';
  await data.player.pm(message);
}

await main();
