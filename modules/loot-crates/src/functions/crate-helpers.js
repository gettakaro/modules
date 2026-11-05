import { takaro, TakaroUserError } from '@takaro/helpers';

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

const KEY_PREFIX = 'loot_crates_keys:';
const ORDER_PREFIX = 'loot_crates_order:';

export function rarityRank(rarity) {
  const rank = RARITIES.indexOf(rarity || 'common');
  return rank === -1 ? 0 : rank;
}

export function getCrates(config) {
  return Array.isArray(config.crates) ? config.crates : [];
}

export function findCrate(config, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  return getCrates(config).find((crate) => String(crate.name).toLowerCase() === wanted) || null;
}

export function crateNames(config) {
  return getCrates(config)
    .map((crate) => crate.name)
    .join(', ');
}

export function requireCrate(config, name, prefix) {
  const crates = getCrates(config);
  if (crates.length === 0) {
    throw new TakaroUserError('No crates are set up yet. Ask an admin to configure the loot-crates module.');
  }
  if (!String(name || '').trim()) {
    throw new TakaroUserError(`Name a crate. Crates: ${crateNames(config)}. See ${prefix}crates.`);
  }
  const crate = findCrate(config, name);
  if (!crate) {
    throw new TakaroUserError(`No crate called "${name}". Crates: ${crateNames(config)}.`);
  }
  return crate;
}

export async function getSetting(key, gameServerId, fallback) {
  try {
    const res = await takaro.settings.settingsControllerGetOne(key, gameServerId);
    return res.data.data.value || fallback;
  } catch {
    return fallback;
  }
}

export async function getPrefix(gameServerId) {
  return getSetting('commandPrefix', gameServerId, '/');
}

export async function getCurrencyName(gameServerId) {
  return getSetting('currencyName', gameServerId, 'coins');
}

/** Optional command arguments default to "-" (Takaro treats an empty default as missing). */
export function argValue(raw) {
  const text = String(raw ?? '').trim();
  return text === '-' ? '' : text;
}

export function parseCount(raw, fallback) {
  const text = String(raw ?? '').trim();
  if (text === '') return fallback;
  if (!/^\d+$/.test(text)) return NaN;
  return parseInt(text, 10);
}

async function findVariable(key, gameServerId, playerId, moduleId) {
  const filters = { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] };
  if (playerId) filters.playerId = [playerId];
  const res = await takaro.variable.variableControllerSearch({ filters });
  return res.data.data[0] || null;
}

function keyName(crate) {
  return KEY_PREFIX + String(crate.name).toLowerCase();
}

export async function getKeys(crate, gameServerId, playerId, moduleId) {
  const variable = await findVariable(keyName(crate), gameServerId, playerId, moduleId);
  const count = variable ? parseInt(variable.value, 10) : 0;
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/** Adds `delta` keys (may be negative). Returns the new count. Never goes below 0. */
export async function addKeys(crate, gameServerId, playerId, moduleId, delta) {
  const key = keyName(crate);
  const variable = await findVariable(key, gameServerId, playerId, moduleId);
  const current = variable ? parseInt(variable.value, 10) || 0 : 0;
  const next = Math.max(0, current + delta);
  if (variable) {
    await takaro.variable.variableControllerUpdate(variable.id, { value: String(next) });
  } else {
    await takaro.variable.variableControllerCreate({ key, value: String(next), gameServerId, playerId, moduleId });
  }
  return next;
}

/** Marks a shop order as handled. Returns false when it was handled before. */
export async function claimOrder(orderId, gameServerId, playerId, moduleId) {
  const key = ORDER_PREFIX + orderId;
  if (await findVariable(key, gameServerId, playerId, moduleId)) return false;
  await takaro.variable.variableControllerCreate({
    key,
    value: new Date().toISOString(),
    gameServerId,
    playerId,
    moduleId,
  });
  return true;
}

export function totalWeight(crate) {
  return (crate.rewards || []).reduce((sum, reward) => sum + (Number(reward.weight) > 0 ? Number(reward.weight) : 0), 0);
}

export function rollReward(crate) {
  const rewards = (crate.rewards || []).filter((reward) => Number(reward.weight) > 0);
  if (rewards.length === 0) {
    throw new TakaroUserError(`The ${crate.name} crate has no rewards. Ask an admin to configure it.`);
  }
  let roll = Math.random() * totalWeight(crate);
  for (const reward of rewards) {
    roll -= Number(reward.weight);
    if (roll < 0) return reward;
  }
  return rewards[rewards.length - 1];
}

export function formatPercent(weight, total) {
  const pct = (weight / total) * 100;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 1) return `${pct.toFixed(1).replace(/\.0$/, '')}%`;
  return `${pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

export function describeReward(reward, currencyName) {
  const parts = [];
  if (Number(reward.currency) > 0) parts.push(`${reward.currency} ${currencyName}`);
  for (const line of reward.items || []) {
    parts.push(`${line.amount || 1}x ${line.item}`);
  }
  return parts.join(' + ');
}

/**
 * Gives the reward. Items first, currency last.
 * Returns { given: string[], failed: string[] }.
 */
export async function giveReward(reward, gameServerId, playerId, currencyName) {
  const given = [];
  const failed = [];
  for (const line of reward.items || []) {
    const label = `${line.amount || 1}x ${line.item}`;
    try {
      await takaro.gameserver.gameServerControllerGiveItem(gameServerId, playerId, {
        name: line.item,
        amount: line.amount || 1,
        quality: line.quality ?? '',
      });
      given.push(label);
    } catch (error) {
      console.error(`loot-crates: giving ${label} failed: ${error?.response?.data?.meta?.error?.message ?? error}`);
      failed.push(label);
    }
  }
  if (Number(reward.currency) > 0) {
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, {
      currency: Number(reward.currency),
    });
    given.push(`${reward.currency} ${currencyName}`);
  }
  return { given, failed };
}

export function fillTemplate(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}
