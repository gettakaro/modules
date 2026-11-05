import { takaro } from '@takaro/helpers';

const DEFAULT_BUFF_COMMAND_TEMPLATE = 'buffplayer {playerName} {buffName}';
const DEFAULT_REWARD_MESSAGE = '{playerName} received a playtime reward: {rewardName}.';
const PLAYTIME_STATE_KEY = 'playtime_buff_reward_state';

export function trimOrEmpty(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

export function renderTemplate(template, placeholders) {
  return trimOrEmpty(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(placeholders, key)) {
      return String(placeholders[key]);
    }
    return `{${key}}`;
  });
}

export function getCommandTargetPlayer(target) {
  if (!target || typeof target !== 'object') return null;

  const playerId = trimOrEmpty(target.playerId || target.id);
  if (playerId === '') return null;

  return {
    playerId,
    name: trimOrEmpty(target.name || target.playerName || target.player?.name) || 'Unknown Player',
    gameId: trimOrEmpty(target.gameId),
    online: target.online,
  };
}

async function getPlayerName(playerId, fallback) {
  try {
    const res = await takaro.player.playerControllerGetOne(playerId);
    return trimOrEmpty(res.data?.data?.name) || fallback;
  } catch (err) {
    console.error(`playtime-buff-rewards: failed to fetch player name for ${playerId}: ${err}`);
    return fallback;
  }
}

async function findPlayerStateVariable(gameServerId, moduleId, playerId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: {
      key: [PLAYTIME_STATE_KEY],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
      playerId: [playerId],
    },
  });
  return res.data.data.length > 0 ? res.data.data[0] : null;
}

async function getPlayerRewardState(gameServerId, moduleId, playerId) {
  const variable = await findPlayerStateVariable(gameServerId, moduleId, playerId);
  if (!variable) return { lastRewardBucket: 0 };
  try {
    const parsed = JSON.parse(variable.value);
    return {
      lastRewardBucket: Math.max(0, Math.floor(Number(parsed.lastRewardBucket || 0))),
    };
  } catch (err) {
    console.error(`playtime-buff-rewards: failed to parse reward state for player ${playerId}: ${err}`);
    return { lastRewardBucket: 0 };
  }
}

async function setPlayerRewardState(gameServerId, moduleId, playerId, state) {
  const value = JSON.stringify(state);
  const existing = await findPlayerStateVariable(gameServerId, moduleId, playerId);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value });
    return;
  }

  await takaro.variable.variableControllerCreate({
    key: PLAYTIME_STATE_KEY,
    value,
    gameServerId,
    moduleId,
    playerId,
  });
}

function getPlaytimeIntervalMinutes(config) {
  const interval = Math.floor(Number(config?.playtimeIntervalMinutes || 0));
  if (!Number.isFinite(interval) || interval < 1) return 0;
  return interval;
}

async function getEligibleRewardBucket(gameServerId, moduleId, config, target) {
  const intervalMinutes = getPlaytimeIntervalMinutes(config);
  if (intervalMinutes === 0) return null;

  const playtimeSeconds = Math.max(0, Number(target.playtimeSeconds || 0));
  const currentBucket = Math.floor(playtimeSeconds / (intervalMinutes * 60));
  if (currentBucket < 1) return null;

  const state = await getPlayerRewardState(gameServerId, moduleId, target.playerId);
  if (currentBucket <= state.lastRewardBucket) return null;
  return currentBucket;
}

export function normalizeBuffName(value) {
  const buffName = trimOrEmpty(value);
  return buffName === '' ? null : buffName;
}

function normalizeWeight(value) {
  const weight = Number(value ?? 1);
  if (!Number.isFinite(weight) || weight < 1) return 1;
  return Math.floor(weight);
}

function playerPlaceholders(target, extra = {}) {
  return {
    playerName: target.name,
    playerId: target.playerId,
    gameId: target.gameId || target.playerId,
    ...extra,
  };
}

export function buildBuffCommand(config, target, buffName) {
  const template = trimOrEmpty(config?.buffCommandTemplate) || DEFAULT_BUFF_COMMAND_TEMPLATE;
  return renderTemplate(template, playerPlaceholders(target, { buffName }));
}

function normalizeBuffRewards(config) {
  const rewards = Array.isArray(config?.buffRewards) ? config.buffRewards : [];
  return rewards
    .filter((reward) => reward && reward.enabled !== false)
    .map((reward) => {
      const buffName = normalizeBuffName(reward.buffName);
      if (!buffName) return null;
      return {
        type: 'buff',
        name: buffName,
        buffName,
        weight: normalizeWeight(reward.weight),
        message: trimOrEmpty(reward.message),
      };
    })
    .filter(Boolean);
}

function normalizeCommandRewards(config) {
  const rewards = Array.isArray(config?.commandRewards) ? config.commandRewards : [];
  return rewards
    .filter((reward) => reward && reward.enabled !== false)
    .map((reward) => {
      const command = trimOrEmpty(reward.command);
      const name = trimOrEmpty(reward.name);
      if (command === '' || name === '') return null;
      return {
        type: 'command',
        name,
        command,
        weight: normalizeWeight(reward.weight),
        message: trimOrEmpty(reward.message),
      };
    })
    .filter(Boolean);
}

function normalizeCurrencyRewards(config) {
  const rewards = Array.isArray(config?.currencyRewards) ? config.currencyRewards : [];
  return rewards
    .filter((reward) => reward && reward.enabled !== false)
    .map((reward) => {
      const amount = Math.floor(Number(reward.amount));
      if (!Number.isFinite(amount) || amount < 1) return null;
      return {
        type: 'currency',
        name: trimOrEmpty(reward.name) || `${amount} currency`,
        amount,
        weight: normalizeWeight(reward.weight),
        message: trimOrEmpty(reward.message),
      };
    })
    .filter(Boolean);
}

export function getConfiguredRewards(config) {
  return [
    ...normalizeBuffRewards(config),
    ...normalizeCommandRewards(config),
    ...normalizeCurrencyRewards(config),
  ];
}

export function pickWeightedReward(rewards) {
  if (!Array.isArray(rewards) || rewards.length === 0) return null;
  const totalWeight = rewards.reduce((sum, reward) => sum + normalizeWeight(reward.weight), 0);
  let cursor = Math.random() * totalWeight;
  for (const reward of rewards) {
    cursor -= normalizeWeight(reward.weight);
    if (cursor < 0) return reward;
  }
  return rewards[rewards.length - 1];
}

async function sendRewardMessage(gameServerId, config, target, reward, extra = {}) {
  if (config?.announceRewards === false) return;

  const template = trimOrEmpty(reward.message) || trimOrEmpty(config?.defaultRewardMessage) || DEFAULT_REWARD_MESSAGE;
  const message = renderTemplate(template, playerPlaceholders(target, {
    rewardName: reward.name,
    buffName: reward.buffName || '',
    amount: reward.amount || '',
    ...extra,
  }));

  if (message === '') return;
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message,
    opts: {},
  });
}

export async function grantBuffToPlayer(gameServerId, config, target, buffName) {
  const command = buildBuffCommand(config, target, buffName);
  await takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, { command });
  console.log(`playtime-buff-rewards: executed buff command "${command}" for player ${target.name}`);
  return command;
}

export async function grantRewardToPlayer(gameServerId, config, target, reward) {
  if (reward.type === 'buff') {
    const command = await grantBuffToPlayer(gameServerId, config, target, reward.buffName);
    await sendRewardMessage(gameServerId, config, target, reward);
    return { type: reward.type, name: reward.name, command };
  }

  if (reward.type === 'command') {
    const command = renderTemplate(reward.command, playerPlaceholders(target, { rewardName: reward.name }));
    await takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, { command });
    console.log(`playtime-buff-rewards: executed command reward "${command}" for player ${target.name}`);
    await sendRewardMessage(gameServerId, config, target, reward);
    return { type: reward.type, name: reward.name, command };
  }

  if (reward.type === 'currency') {
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, target.playerId, {
      currency: reward.amount,
    });
    console.log(`playtime-buff-rewards: granted ${reward.amount} currency to ${target.name}`);
    await sendRewardMessage(gameServerId, config, target, reward);
    return { type: reward.type, name: reward.name, amount: reward.amount };
  }

  throw new Error(`Unsupported reward type: ${reward.type}`);
}

export async function findOnlinePlayers(gameServerId) {
  const players = [];
  const limit = 100;
  let page = 0;
  let iterations = 0;

  while (true) {
    iterations++;
    if (iterations > 100) {
      console.error('playtime-buff-rewards: exceeded online-player pagination cap');
      break;
    }

    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [gameServerId],
        online: [true],
      },
      limit,
      page,
    });

    const records = res.data.data;
    const targets = await Promise.all(records.map(async (record) => {
      const target = getCommandTargetPlayer(record);
      if (!target) return null;
      const fallbackName = target.gameId || target.playerId;
      return {
        ...target,
        playtimeSeconds: Number(record.playtimeSeconds || 0),
        name: await getPlayerName(target.playerId, fallbackName),
      };
    }));
    players.push(...targets.filter(Boolean));
    if (records.length < limit) break;
    page++;
  }

  return players;
}

export async function grantPlaytimeRewards(gameServerId, mod) {
  const config = mod.userConfig || {};
  const moduleId = mod.moduleId;
  const intervalMinutes = getPlaytimeIntervalMinutes(config);
  const rewards = getConfiguredRewards(config);
  if (rewards.length === 0) {
    console.log('playtime-buff-rewards: no rewards configured');
    return { playersChecked: 0, rewardsGranted: 0 };
  }

  if (intervalMinutes > 0 && !moduleId) {
    console.error('playtime-buff-rewards: playtimeIntervalMinutes requires moduleId but data.module.moduleId was missing');
    return { playersChecked: 0, rewardsGranted: 0 };
  }

  const players = await findOnlinePlayers(gameServerId);
  if (players.length === 0) {
    console.log('playtime-buff-rewards: no online players found');
    return { playersChecked: 0, rewardsGranted: 0 };
  }

  let rewardsGranted = 0;
  let playersEligible = 0;
  for (const target of players) {
    const eligibleBucket = await getEligibleRewardBucket(gameServerId, moduleId, config, target);
    if (intervalMinutes > 0 && eligibleBucket === null) continue;

    playersEligible++;
    const reward = pickWeightedReward(rewards);
    if (!reward) continue;
    try {
      await grantRewardToPlayer(gameServerId, config, target, reward);
      if (intervalMinutes > 0) {
        await setPlayerRewardState(gameServerId, moduleId, target.playerId, {
          lastRewardBucket: eligibleBucket,
          lastRewardedAt: new Date().toISOString(),
          playtimeSeconds: Math.max(0, Number(target.playtimeSeconds || 0)),
        });
      }
      rewardsGranted++;
    } catch (err) {
      console.error(`playtime-buff-rewards: failed to grant reward to ${target.name}: ${err}`);
    }
  }

  if (intervalMinutes > 0 && playersEligible === 0) {
    console.log(`playtime-buff-rewards: no players reached a new ${intervalMinutes} minute playtime interval`);
  }
  console.log(`playtime-buff-rewards: granted ${rewardsGranted} reward(s) to ${players.length} online player(s)`);
  return { playersChecked: players.length, rewardsGranted };
}
