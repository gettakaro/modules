import { takaro, data, TakaroUserError } from '@takaro/helpers';

const VARIABLE_KEY = 't_starterkit_lock';

const SET_MISSING =
  'The starter kit item set no longer exists. Please ask your server administrator to reconfigure the starter kit.';

function describe(lines) {
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
    throw new TakaroUserError(
      'The starter kit item set has no items. Please ask your server administrator to configure this.',
    );
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
      throw new TakaroUserError(`Your starter kit could not be given: ${reason}`);
    }
    throw error;
  }
}

async function main() {
  const setId = data.module.userConfig.starterKitItemSet;

  if (!setId) {
    throw new TakaroUserError(
      'No starter kit item set configured. Please ask your server administrator to configure this.',
    );
  }

  const starterKitLockRes = await takaro.variable.variableControllerSearch({
    filters: {
      key: [VARIABLE_KEY],
      gameServerId: [data.gameServerId],
      playerId: [data.player.id],
    },
  });

  if (starterKitLockRes.data.data.length > 0) {
    throw new TakaroUserError('You already used starterkit on this server');
  }

  const set = await readSet(setId);

  await data.player.pm('You are about to receive your starter kit...');

  const results = await giveLines(set);
  const failed = results.filter((line) => line.result === 'FAILED');
  const unknown = results.filter((line) => line.result === 'UNKNOWN');
  const delivered = results.filter((line) => line.result === 'DELIVERED');

  if (failed.length === results.length) {
    throw new TakaroUserError(
      'Your starter kit could not be given. Please try again later or contact a server administrator.',
    );
  }

  await takaro.variable.variableControllerCreate({
    key: VARIABLE_KEY,
    value: '1',
    gameServerId: data.gameServerId,
    playerId: data.player.id,
  });

  if (delivered.length === results.length) {
    await data.player.pm(`Gave ${results.length} items, enjoy!`);
    return;
  }

  let message = `Gave ${delivered.length} of ${results.length} items.`;
  if (failed.length > 0) {
    message += ` These could not be given: ${describe(failed)}.`;
  }
  if (unknown.length > 0) {
    message += ` These may not have arrived: ${describe(unknown)}.`;
  }
  message += ' Please contact a server administrator.';
  await data.player.pm(message);
}

await main();
