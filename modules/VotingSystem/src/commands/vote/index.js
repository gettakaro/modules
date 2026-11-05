import { takaro, data, axios } from '@takaro/helpers';

function buildVoteApiUrl(votingsite, params) {
  const baseUrl = new URL(votingsite);
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error('Voting site URL must use http or https.');
  }

  const apiUrl = new URL('/api/', baseUrl);
  for (const [key, value] of Object.entries(params)) {
    apiUrl.searchParams.set(key, String(value));
  }

  return apiUrl.toString();
}

function sanitizeError(error) {
  return {
    message: error?.message,
    status: error?.response?.status,
    statusText: error?.response?.statusText,
    responseData:
      typeof error?.response?.data === 'string'
        ? error.response.data.slice(0, 200)
        : error?.response?.data,
  };
}

function getRewardAmount(itemConfig, fallbackAmount = 1) {
  const amount = itemConfig?.amount ?? fallbackAmount;
  if (!Number.isInteger(amount) || amount < 1) {
    throw new Error('Vote reward item amounts must be whole numbers of at least 1.');
  }

  return amount;
}

async function resolveConfiguredItem(itemConfig, fallbackAmount = 1) {
  if (typeof itemConfig === 'string') {
    return {
      gameItemName: itemConfig,
      displayName: itemConfig,
      amount: fallbackAmount,
      quality: '0',
    };
  }

  if (!itemConfig?.item) {
    throw new Error('Vote reward item config is missing an item.');
  }

  const item = (await takaro.item.itemControllerFindOne(itemConfig.item)).data.data;
  const amount = getRewardAmount(itemConfig, fallbackAmount);

  return {
    gameItemName: item.id,
    displayName: item.name,
    amount,
    quality: itemConfig.quality ?? '',
  };
}

async function giveResolvedItem(item) {
  try {
    await takaro.gameserver.gameServerControllerGiveItem(data.gameServerId, data.player.id, {
      name: item.gameItemName,
      amount: item.amount,
      quality: item.quality,
    });
  } catch (error) {
    // Some games do not support item quality. Retry without quality before failing the reward.
    await takaro.gameserver.gameServerControllerGiveItem(data.gameServerId, data.player.id, {
      name: item.gameItemName,
      amount: item.amount,
      quality: '',
    });
  }
}

function selectRandomRewards(randomitemnumber, randomitemlist = []) {
  const availableRandomRewards = [...randomitemlist];
  const requestedCount = Number.isInteger(randomitemnumber) ? randomitemnumber : 0;
  const actualRandomItemNumber = Math.min(Math.max(requestedCount, 0), availableRandomRewards.length);
  const selectedRewards = [];

  for (let i = 0; i < actualRandomItemNumber; i++) {
    const randomIndex = Math.floor(Math.random() * availableRandomRewards.length);
    selectedRewards.push(availableRandomRewards.splice(randomIndex, 1)[0]);
  }

  return selectedRewards;
}

async function main() {
  const {
    votingsite,
    votekey,
    novote,
    alreadyclaimed,
    privatemessage,
    publicmessage,
    currency,
    randomitemnumber,
    randomitemlist = [],
    fixedrewards = [],
  } = data.module.userConfig;
  const { steamId } = data.player;

  const voteIdentity = steamId ? { steamid: steamId } : { username: data.player.name };

  let votingSiteResponse;
  try {
    votingSiteResponse = String(
      (
        await axios.get(
          buildVoteApiUrl(votingsite, {
            object: 'votes',
            element: 'claim',
            key: votekey,
            ...voteIdentity,
          }),
        )
      ).data,
    );
  } catch (error) {
    console.log('Failed to check vote status:', sanitizeError(error));
    await data.player.pm('Could not check your vote right now. Please try again later.');
    return;
  }

  if (votingSiteResponse === 'Error: server key not found') {
    await data.player.pm('The server vote key is invalid, please notify the admins.');
    return;
  }
  if (votingSiteResponse === '0') {
    await data.player.pm(novote);
    return;
  }
  if (votingSiteResponse === '2') {
    await data.player.pm(alreadyclaimed);
    return;
  }
  if (votingSiteResponse !== '1') {
    console.log('Unexpected vote status response:', votingSiteResponse);
    await data.player.pm('The voting site returned an unexpected response. Please notify the admins.');
    return;
  }

  let itemRewards;
  try {
    const randomRewards = selectRandomRewards(randomitemnumber, randomitemlist);
    itemRewards = await Promise.all([...randomRewards, ...fixedrewards].map((reward) => resolveConfiguredItem(reward)));
  } catch (error) {
    console.log('Vote reward configuration is invalid:', sanitizeError(error));
    await data.player.pm('Vote rewards are not configured correctly. Please notify the admins.');
    return;
  }

  let claimResponse;
  try {
    claimResponse = String(
      (
        await axios.post(
          buildVoteApiUrl(votingsite, {
            action: 'post',
            object: 'votes',
            element: 'claim',
            key: votekey,
            ...voteIdentity,
          }),
        )
      ).data,
    );
  } catch (error) {
    console.log('Failed to claim vote reward:', sanitizeError(error));
    await data.player.pm('Something went wrong while claiming your vote reward. Please try again later.');
    return;
  }

  if (claimResponse !== '1') {
    await data.player.pm('Something went wrong while claiming your vote reward.');
    console.log('Unexpected vote claim response:', claimResponse);
    return;
  }

  if (privatemessage) {
    await data.player.pm(privatemessage);
  }
  if (publicmessage) {
    await takaro.gameserver.gameServerControllerSendMessage(data.gameServerId, {
      message: publicmessage.replace('{name}', data.player.name),
    });
  }

  const rewardErrors = [];
  const totalItemRewards = itemRewards.length;
  for (let i = 0; i < itemRewards.length; i++) {
    const item = itemRewards[i];
    try {
      await giveResolvedItem(item);
      await data.player.pm(`You received ${item.amount}x ${item.displayName}! (item ${i + 1}/${totalItemRewards})`);
    } catch (error) {
      rewardErrors.push(`item ${item.displayName}`);
      console.log('Failed to give vote item reward:', sanitizeError(error));
    }
  }

  if (currency > 0) {
    try {
      const currencyName = (await takaro.settings.settingsControllerGetOne('currencyName', data.gameServerId)).data.data;
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(data.gameServerId, data.player.id, {
        currency,
      });
      await data.player.pm(`You received ${currency} ${currencyName.value}.`);
    } catch (error) {
      rewardErrors.push('currency');
      console.log('Failed to give vote currency reward:', sanitizeError(error));
    }
  }

  if (rewardErrors.length > 0) {
    await data.player.pm('Your vote was claimed, but some rewards failed. Please notify the admins.');
  }
}

await main();
