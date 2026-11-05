import { takaro, checkPermission } from '@takaro/helpers';

export const ACCOUNT_KEY = 'bank_account';
const PAGE_SIZE = 100;

export function formatAmount(value) {
  const n = Math.trunc(Number(value) || 0);
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'less than a minute';
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  return parts.length ? parts.join(' ') : 'less than a minute';
}

export async function getSetting(key, gameServerId) {
  return (await takaro.settings.settingsControllerGetOne(key, gameServerId)).data.data.value;
}

/** Parses a stored account; a missing or corrupt row reads as an empty account. */
export function parseAccount(row) {
  const empty = { balance: 0, name: null, totalInterest: 0, lastInterest: 0, lastInterestAt: null };
  if (!row) return empty;
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object') return empty;
    return {
      balance: Math.max(0, Math.floor(Number(parsed.balance) || 0)),
      name: typeof parsed.name === 'string' ? parsed.name : null,
      totalInterest: Math.max(0, Math.floor(Number(parsed.totalInterest) || 0)),
      lastInterest: Math.max(0, Math.floor(Number(parsed.lastInterest) || 0)),
      lastInterestAt: typeof parsed.lastInterestAt === 'string' ? parsed.lastInterestAt : null,
    };
  } catch (err) {
    console.error(`bank: could not parse account ${row.id}: ${err}`);
    return empty;
  }
}

export async function getAccountRow(gameServerId, moduleId, playerId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: { key: [ACCOUNT_KEY], gameServerId: [gameServerId], moduleId: [moduleId], playerId: [playerId] },
  });
  return res.data.data.length > 0 ? res.data.data[0] : null;
}

/** Writes the account. Updates `row` when it exists, otherwise creates it. Returns the row id. */
export async function saveAccount(row, scope, account) {
  const value = JSON.stringify(account);
  if (row) {
    await takaro.variable.variableControllerUpdate(row.id, { value });
    return row.id;
  }
  const created = await takaro.variable.variableControllerCreate({
    key: ACCOUNT_KEY,
    value,
    gameServerId: scope.gameServerId,
    moduleId: scope.moduleId,
    playerId: scope.playerId,
  });
  return created.data.data.id;
}

/** Every bank account on this server for this installation, one page at a time. */
export async function listAccountRows(gameServerId, moduleId) {
  const rows = [];
  for (let page = 0; page < 1000; page++) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { key: [ACCOUNT_KEY], gameServerId: [gameServerId], moduleId: [moduleId] },
      page,
      limit: PAGE_SIZE,
    });
    const batch = res.data.data;
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

/** The interest rate for a player: the VIP permission count when it is higher than the base rate. */
export function interestRateFor(pog, baseRate) {
  const vip = pog ? checkPermission(pog, 'BANK_VIP_RATE') : false;
  const vipRate = vip && typeof vip === 'object' && Number.isFinite(vip.count) ? vip.count : 0;
  return Math.max(baseRate, vipRate);
}

/** Interest for one payout, after the minimum balance, the per-payout cap and the balance cap. */
export function computeInterest(balance, rate, config) {
  if (rate <= 0 || balance <= 0 || balance < config.minimumBalanceForInterest) return 0;
  let interest = Math.floor((balance * rate) / 100);
  if (config.maxInterestPerPayout > 0) interest = Math.min(interest, config.maxInterestPerPayout);
  if (config.maxBankBalance > 0) interest = Math.min(interest, Math.max(0, config.maxBankBalance - balance));
  return Math.max(0, interest);
}

export function formatRate(rate) {
  return `${Math.round(rate * 100) / 100}%`;
}
