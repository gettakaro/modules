import { takaro } from '@takaro/helpers';

export const STATE_KEY = 'wtr_state';
export const LAST_RESULTS_KEY = 'wtr_last_results';
export const PENDING_ITEMS_KEY = 'wtr_pending_items';

export const ALL_CATEGORIES = ['playtime', 'kills', 'currency'];
export const PLACES = 3;

const PAGE_SIZE = 1000;
const MAX_POG_PAGES = 20;
// Players unseen for this long are left out of the playtime snapshot to keep it small.
// Such a player who returns mid-week is skipped for playtime until the next snapshot.
const SNAPSHOT_LOOKBACK_MS = 60 * 24 * 60 * 60 * 1000;
// Cap for the per-player kill count fallback (used only when the analytics endpoint is unavailable).
const MAX_KILL_FALLBACK_PLAYERS = 100;

const CATEGORY_ALIASES = {
  playtime: 'playtime',
  time: 'playtime',
  pt: 'playtime',
  online: 'playtime',
  kills: 'kills',
  kill: 'kills',
  k: 'kills',
  currency: 'currency',
  money: 'currency',
  coins: 'currency',
  earned: 'currency',
};

export const CATEGORY_LABELS = {
  playtime: 'Playtime',
  kills: 'Kills',
  currency: 'Earned',
};

// ---------- variables ----------

async function findVariable(key, gameServerId, moduleId, playerId) {
  const filters = { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] };
  if (playerId) filters.playerId = [playerId];
  const res = await takaro.variable.variableControllerSearch({ filters, limit: 1 });
  return res.data.data[0] || null;
}

export async function readJson(key, gameServerId, moduleId, playerId) {
  const variable = await findVariable(key, gameServerId, moduleId, playerId);
  if (!variable) return null;
  try {
    return JSON.parse(variable.value);
  } catch (err) {
    console.error(`weekly-top-rewards: could not parse variable ${key}: ${err}`);
    return null;
  }
}

export async function writeJson(key, gameServerId, moduleId, playerId, value) {
  const existing = await findVariable(key, gameServerId, moduleId, playerId);
  const serialized = JSON.stringify(value);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
    return;
  }
  const body = { key, value: serialized, gameServerId, moduleId };
  if (playerId) body.playerId = playerId;
  await takaro.variable.variableControllerCreate(body);
}

export async function deleteVariable(key, gameServerId, moduleId, playerId) {
  const existing = await findVariable(key, gameServerId, moduleId, playerId);
  if (existing) await takaro.variable.variableControllerDelete(existing.id);
}

// ---------- settings / formatting ----------

export async function getSetting(name, gameServerId, fallback) {
  try {
    const res = await takaro.settings.settingsControllerGetOne(name, gameServerId);
    return res.data.data.value || fallback;
  } catch (err) {
    console.error(`weekly-top-rewards: could not read setting ${name}: ${err}`);
    return fallback;
  }
}

export function resolveCategory(input) {
  if (!input) return null;
  return CATEGORY_ALIASES[String(input).trim().toLowerCase()] || null;
}

export function enabledCategories(config) {
  const list = Array.isArray(config.categories) ? config.categories : ALL_CATEGORIES;
  return ALL_CATEGORIES.filter((c) => list.includes(c));
}

export function formatDuration(seconds) {
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function formatValue(category, value, currencyName) {
  if (category === 'playtime') return formatDuration(value);
  if (category === 'kills') return `${value} kill${value === 1 ? '' : 's'}`;
  return `${value} ${currencyName}`;
}

export function formatDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[d.getUTCDay()]} ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// ---------- period state ----------

async function fetchPogsSeenSince(gameServerId, sinceIso) {
  const pogs = [];
  for (let page = 0; page < MAX_POG_PAGES; page++) {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId] },
      greaterThan: { lastSeen: sinceIso },
      limit: PAGE_SIZE,
      page,
    });
    const rows = res.data.data;
    pogs.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return pogs;
}

/** Baseline for the new period: lifetime playtime per player right now. */
export async function takeSnapshot(gameServerId, nowIso) {
  const since = new Date(new Date(nowIso).getTime() - SNAPSHOT_LOOKBACK_MS).toISOString();
  const pogs = await fetchPogsSeenSince(gameServerId, since);
  const playtime = {};
  for (const pog of pogs) {
    if (pog.playtimeSeconds > 0) playtime[pog.playerId] = pog.playtimeSeconds;
  }
  return { periodStart: nowIso, playtime };
}

export async function loadState(gameServerId, moduleId) {
  const state = await readJson(STATE_KEY, gameServerId, moduleId);
  if (!state || !state.periodStart) return null;
  if (!state.playtime) state.playtime = {};
  return state;
}

export async function startNewPeriod(gameServerId, moduleId, nowIso) {
  const state = await takeSnapshot(gameServerId, nowIso);
  await writeJson(STATE_KEY, gameServerId, moduleId, null, state);
  return state;
}

// ---------- category scores ----------
// Each scorer returns an array of { playerId, value, name? } (unsorted, value > 0).

async function playtimeScores(ctx) {
  const { state } = ctx;
  const periodStartMs = new Date(state.periodStart).getTime();
  const scores = [];
  for (const pog of ctx.activePogs) {
    let base = state.playtime[pog.playerId];
    if (base === undefined) {
      // Unknown baseline: only safe when the player first joined during this period.
      if (new Date(pog.createdAt).getTime() >= periodStartMs) base = 0;
      else continue;
    }
    const delta = (pog.playtimeSeconds || 0) - base;
    if (delta > 0) scores.push({ playerId: pog.playerId, value: delta });
  }
  const minSeconds = Math.max(0, Number(ctx.config.minimumPlaytimeMinutes) || 0) * 60;
  return scores.filter((s) => s.value >= minSeconds);
}

async function killScores(ctx) {
  const { gameServerId, startIso, endIso } = ctx;
  try {
    // One ClickHouse-backed request. Returns the top 25 by K/D (min 5 kills+deaths), re-ranked by kills here.
    const res = await takaro.analytics.analyticsControllerGetPlayerKillLeaderboard(startIso, endIso, gameServerId);
    return res.data.data
      .filter((row) => row.kills > 0)
      .map((row) => ({ playerId: row.playerId, value: row.kills, name: row.playerName }));
  } catch (err) {
    console.log(`weekly-top-rewards: kill leaderboard analytics unavailable (${err}), counting kill events per player`);
  }
  const scores = [];
  for (const pog of ctx.activePogs.slice(0, MAX_KILL_FALLBACK_PLAYERS)) {
    const res = await takaro.event.eventControllerSearch({
      filters: { eventName: ['entity-killed'], gameserverId: [gameServerId], playerId: [pog.playerId] },
      greaterThan: { createdAt: startIso },
      lessThan: { createdAt: endIso },
      limit: 1,
    });
    const total = res.data.meta?.total ?? res.data.data.length;
    if (total > 0) scores.push({ playerId: pog.playerId, value: total });
  }
  return scores;
}

async function currencyScores(ctx) {
  const { gameServerId, moduleId, startIso, endIso, config } = ctx;
  const maxPages = Math.max(1, Math.floor(Number(config.maxCurrencyEventPages) || 10));
  const totals = new Map();
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const res = await takaro.event.eventControllerSearch({
      filters: { eventName: ['currency-added'], gameserverId: [gameServerId] },
      greaterThan: { createdAt: startIso },
      lessThan: { createdAt: endIso },
      sortBy: 'createdAt',
      sortDirection: 'asc',
      limit: PAGE_SIZE,
      page,
    });
    const rows = res.data.data;
    for (const event of rows) {
      if (!event.playerId) continue;
      // Our own payouts never count towards next week's ranking.
      if (event.actingModuleId && event.actingModuleId === moduleId) continue;
      // Grants made by hand in the dashboard have no acting module.
      if (!event.actingModuleId && !config.countManualCurrencyGrants) continue;
      const amount = Number(event.meta?.amount) || 0;
      if (amount <= 0) continue;
      totals.set(event.playerId, (totals.get(event.playerId) || 0) + amount);
    }
    if (rows.length < PAGE_SIZE) break;
    if (page === maxPages - 1) truncated = true;
  }
  if (truncated) console.log(`weekly-top-rewards: currency ranking stopped after ${maxPages} pages; raise maxCurrencyEventPages`);
  return [...totals.entries()].map(([playerId, value]) => ({ playerId, value }));
}

const SCORERS = { playtime: playtimeScores, kills: killScores, currency: currencyScores };

function rank(scores) {
  return scores.sort((a, b) => b.value - a.value || String(a.playerId).localeCompare(String(b.playerId)));
}

/**
 * Live standings for each requested category over [state.periodStart, endIso].
 * Requests: 1 pog search (+1 per 1000 active players), then per category 1 (playtime: none extra,
 * kills: 1 analytics call, currency: 1 per 1000 events). All sequential.
 */
export async function computeStandings({ gameServerId, moduleId, config, state, categories, endIso }) {
  const ctx = {
    gameServerId,
    moduleId,
    config,
    state,
    startIso: state.periodStart,
    endIso,
    activePogs: await fetchPogsSeenSince(gameServerId, state.periodStart),
  };
  const standings = {};
  for (const category of categories) {
    try {
      standings[category] = rank(await SCORERS[category](ctx));
    } catch (err) {
      console.error(`weekly-top-rewards: could not rank ${category}: ${err}`);
      standings[category] = null;
    }
  }
  return standings;
}

/** Fills in `name` for the given entries with one player search. */
export async function attachNames(entries) {
  const missing = [...new Set(entries.filter((e) => !e.name).map((e) => e.playerId))];
  if (missing.length > 0) {
    const res = await takaro.player.playerControllerSearch({ filters: { id: missing }, limit: missing.length });
    const names = new Map(res.data.data.map((p) => [p.id, p.name]));
    for (const entry of entries) {
      if (!entry.name) entry.name = names.get(entry.playerId) || 'Unknown';
    }
  }
  return entries;
}

// ---------- rewards ----------

export function itemsForPlace(config, place) {
  const key = ['firstPlaceItems', 'secondPlaceItems', 'thirdPlaceItems'][place - 1];
  const list = config[key];
  return Array.isArray(list) ? list.filter((i) => i && i.item) : [];
}

export function currencyForPlace(config, place) {
  const list = Array.isArray(config.currencyRewards) ? config.currencyRewards : [];
  return Math.max(0, Math.floor(Number(list[place - 1]) || 0));
}

async function giveItems(gameServerId, playerId, items) {
  const failed = [];
  for (const item of items) {
    try {
      await takaro.gameserver.gameServerControllerGiveItem(gameServerId, playerId, {
        name: item.item,
        amount: item.amount || 1,
        quality: item.quality ?? '',
      });
    } catch (err) {
      console.error(`weekly-top-rewards: give item ${item.item} to ${playerId} failed: ${err}`);
      failed.push(item);
    }
  }
  return failed;
}

export async function queuePendingItems(gameServerId, moduleId, playerId, items) {
  if (items.length === 0) return;
  const existing = (await readJson(PENDING_ITEMS_KEY, gameServerId, moduleId, playerId)) || [];
  await writeJson(PENDING_ITEMS_KEY, gameServerId, moduleId, playerId, existing.concat(items));
}

/** Delivers queued items to an online player. Returns how many were delivered. */
export async function deliverPendingItems(gameServerId, moduleId, playerId) {
  const pending = await readJson(PENDING_ITEMS_KEY, gameServerId, moduleId, playerId);
  if (!pending || pending.length === 0) return 0;
  const failed = await giveItems(gameServerId, playerId, pending);
  if (failed.length === 0) await deleteVariable(PENDING_ITEMS_KEY, gameServerId, moduleId, playerId);
  else await writeJson(PENDING_ITEMS_KEY, gameServerId, moduleId, playerId, failed);
  return pending.length - failed.length;
}

/**
 * Pays one winner. Currency always; items now if online, else queued for next login;
 * the optional role with an expiry date. Each part fails on its own without stopping the rest.
 */
export async function rewardWinner({ gameServerId, moduleId, config, playerId, place, nowMs }) {
  const result = { currency: 0, itemsGiven: 0, itemsQueued: 0, role: false };

  const amount = currencyForPlace(config, place);
  if (amount > 0) {
    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, {
        currency: amount,
      });
      result.currency = amount;
    } catch (err) {
      console.error(`weekly-top-rewards: add currency to ${playerId} failed: ${err}`);
    }
  }

  const items = itemsForPlace(config, place);
  if (items.length > 0) {
    let online = false;
    try {
      const pog = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, playerId);
      online = Boolean(pog.data.data.online);
    } catch (err) {
      console.error(`weekly-top-rewards: could not load player ${playerId}: ${err}`);
    }
    const toQueue = online ? await giveItems(gameServerId, playerId, items) : items;
    result.itemsGiven = items.length - toQueue.length;
    await queuePendingItems(gameServerId, moduleId, playerId, toQueue);
    result.itemsQueued = toQueue.length;
  }

  if (config.rewardRoleId && Number(config.rewardRoleDays) > 0) {
    try {
      const expiresAt = new Date(nowMs + Number(config.rewardRoleDays) * 24 * 60 * 60 * 1000).toISOString();
      await takaro.player.playerControllerAssignRole(playerId, config.rewardRoleId, { gameServerId, expiresAt });
      result.role = true;
    } catch (err) {
      console.error(`weekly-top-rewards: assign role to ${playerId} failed: ${err}`);
    }
  }

  return result;
}
