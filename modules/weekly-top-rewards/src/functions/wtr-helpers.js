import { takaro } from '@takaro/helpers';

export const STATE_KEY = 'wtr_state';
export const LAST_RESULTS_KEY = 'wtr_last_results';
export const PENDING_ITEMS_KEY = 'wtr_pending_items';

export const ALL_CATEGORIES = ['playtime', 'kills', 'currency'];
export const PLACES = 3;

const PAGE_SIZE = 1000;
const MAX_POG_PAGES = 20;
// Upper limit of 1000-event pages of connect/disconnect events read for the playtime ranking.
const MAX_SESSION_EVENT_PAGES = 20;
const SESSION_EVENTS = ['player-connected', 'player-disconnected'];
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

async function fetchOnlinePlayerIds(gameServerId) {
  const ids = [];
  for (let page = 0; page < MAX_POG_PAGES; page++) {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], online: [true] },
      limit: PAGE_SIZE,
      page,
    });
    const rows = res.data.data;
    ids.push(...rows.filter((p) => p.online !== false).map((p) => p.playerId));
    if (rows.length < PAGE_SIZE) break;
  }
  return ids;
}

/** State for a new period: its start time and who is online right now (their session counts from here). */
export async function takeSnapshot(gameServerId, nowIso) {
  return { periodStart: nowIso, onlineAtStart: await fetchOnlinePlayerIds(gameServerId) };
}

export async function loadState(gameServerId, moduleId) {
  const state = await readJson(STATE_KEY, gameServerId, moduleId);
  if (!state || !state.periodStart) return null;
  return state;
}

export async function startNewPeriod(gameServerId, moduleId, nowIso) {
  const state = await takeSnapshot(gameServerId, nowIso);
  await writeJson(STATE_KEY, gameServerId, moduleId, null, state);
  return state;
}

// ---------- category scores ----------
// Each scorer returns an array of { playerId, value, name? } (unsorted, value > 0).

async function fetchSessionEvents(gameServerId, startIso, endIso) {
  const events = [];
  for (let page = 0; page < MAX_SESSION_EVENT_PAGES; page++) {
    const res = await takaro.event.eventControllerSearch({
      filters: { eventName: SESSION_EVENTS, gameserverId: [gameServerId] },
      greaterThan: { createdAt: startIso },
      lessThan: { createdAt: endIso },
      sortBy: 'createdAt',
      sortDirection: 'asc',
      limit: PAGE_SIZE,
      page,
    });
    const rows = res.data.data;
    events.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    if (page === MAX_SESSION_EVENT_PAGES - 1) {
      console.log(`weekly-top-rewards: playtime ranking stopped after ${MAX_SESSION_EVENT_PAGES} pages of session events`);
    }
  }
  return events;
}

/**
 * Seconds each player was online inside [startMs, endMs], from connect/disconnect events.
 * Takaro only updates the lifetime playtime counter on disconnect, so it can't be used for a
 * live weekly ranking. Sessions are clamped to the window:
 * - a player online at the period start (onlineAtStart) has a session open from startMs;
 *   when onlineAtStart is unknown (state from an older version), a first event that is a
 *   disconnect means the session started before the period;
 * - a session still open at the end counts up to endMs when the player is online now,
 *   otherwise up to their lastSeen (the disconnect event went missing);
 * - a second connect without a disconnect in between drops the earlier open session
 *   (its end is unknown, so it is not counted).
 *
 * @param events   session events sorted by createdAt ascending ({ eventName, playerId, createdAt })
 * @param pogs     players seen in the period ({ playerId, online, lastSeen })
 */
export function sessionPlaytime(events, pogs, startMs, endMs, onlineAtStart) {
  const byPlayer = new Map();
  for (const event of events) {
    if (!event.playerId) continue;
    if (!byPlayer.has(event.playerId)) byPlayer.set(event.playerId, []);
    byPlayer.get(event.playerId).push(event);
  }
  const pogById = new Map(pogs.map((p) => [p.playerId, p]));
  const startSet = Array.isArray(onlineAtStart) ? new Set(onlineAtStart) : null;
  const playerIds = new Set([...byPlayer.keys(), ...pogById.keys()]);
  const totals = new Map();

  for (const playerId of playerIds) {
    const list = byPlayer.get(playerId) || [];
    const pog = pogById.get(playerId);
    let openAt = null;
    if (startSet) {
      if (startSet.has(playerId)) openAt = startMs;
    } else if (list.length > 0 ? list[0].eventName === 'player-disconnected' : Boolean(pog && pog.online)) {
      openAt = startMs;
    }
    let total = 0;
    for (const event of list) {
      const at = Math.min(Math.max(new Date(event.createdAt).getTime(), startMs), endMs);
      if (event.eventName === 'player-connected') {
        openAt = at;
      } else if (openAt !== null) {
        total += Math.max(0, at - openAt);
        openAt = null;
      }
    }
    if (openAt !== null && pog) {
      const lastSeenMs = pog.lastSeen ? new Date(pog.lastSeen).getTime() : openAt;
      const end = pog.online ? endMs : Math.min(Math.max(lastSeenMs, openAt), endMs);
      total += Math.max(0, end - openAt);
    }
    const seconds = Math.floor(total / 1000);
    if (seconds > 0) totals.set(playerId, seconds);
  }
  return totals;
}

async function playtimeScores(ctx) {
  const { state, gameServerId, startIso, endIso } = ctx;
  const events = await fetchSessionEvents(gameServerId, startIso, endIso);
  const totals = sessionPlaytime(
    events,
    ctx.activePogs,
    new Date(state.periodStart).getTime(),
    new Date(endIso).getTime(),
    state.onlineAtStart,
  );
  const minSeconds = Math.max(0, Number(ctx.config.minimumPlaytimeMinutes) || 0) * 60;
  return [...totals.entries()]
    .map(([playerId, value]) => ({ playerId, value }))
    .filter((s) => s.value >= minSeconds);
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

// ---------- live Discord leaderboard ----------

export const DISCORD_LIVE_KEY = 'wtr_discord_live';
const EMBED_COLOR = 0xf1c40f;

/** Player names come from players; never let them ping @everyone or a user/role. */
export function sanitizeDiscord(text) {
  return String(text ?? '')
    .replace(/@everyone/g, '@​everyone')
    .replace(/@here/g, '@​here')
    .replace(/<@([!&]?)(\d+)>/g, '<@$1​$2>');
}

export function liveListSize(config) {
  return Math.min(10, Math.max(3, Math.floor(Number(config.discordLiveSize) || 5)));
}

/**
 * One embed with a field per category. `final` turns it into the closed week's results.
 * Entries must already carry names.
 */
export function buildLeaderboardEmbed({ standings, categories, periodStart, periodEnd, currencyName, size, final, nowIso }) {
  const fields = categories.map((category) => {
    const ranked = standings[category];
    let value;
    if (ranked === null || ranked === undefined) value = 'Not available right now.';
    else if (ranked.length === 0) value = 'Nobody yet.';
    else {
      value = ranked
        .slice(0, size)
        .map((e, i) => `**${i + 1}.** ${sanitizeDiscord(e.name)} - ${formatValue(category, e.value, currencyName)}`)
        .join('\n');
    }
    return { name: CATEGORY_LABELS[category], value: value.slice(0, 1024), inline: true };
  });
  const range = final ? `${formatDate(periodStart)} - ${formatDate(periodEnd)}` : `Since ${formatDate(periodStart)}`;
  return {
    title: final ? 'Weekly Top - final results' : 'Weekly Top - live standings',
    description: final ? `${range}\nTop 3 in each category have been rewarded.` : `${range}\nUpdates automatically.`,
    color: EMBED_COLOR,
    fields,
    footer: { text: final ? 'A new week has started.' : `Last updated ${formatDate(nowIso)}` },
  };
}

/**
 * Keeps one Discord message per week up to date: edits it when it exists for this week,
 * posts a new one otherwise (new week, other channel, or the old one was deleted).
 */
export async function upsertLiveMessage({ gameServerId, moduleId, channelId, periodStart, embed }) {
  const stored = await readJson(DISCORD_LIVE_KEY, gameServerId, moduleId);
  if (stored && stored.messageId && stored.channelId === channelId && stored.periodStart === periodStart) {
    try {
      await takaro.discord.discordControllerUpdateMessage(channelId, stored.messageId, { embed });
      return stored.messageId;
    } catch (err) {
      console.error(`weekly-top-rewards: could not edit Discord message ${stored.messageId}, posting a new one: ${err}`);
    }
  }
  const sent = await takaro.discord.discordControllerSendMessage(channelId, { embed });
  const messageId = sent?.data?.data?.id;
  if (messageId) await writeJson(DISCORD_LIVE_KEY, gameServerId, moduleId, null, { channelId, messageId, periodStart });
  return messageId || null;
}

/** Live standings with names for the top `size` of each category. */
export async function liveStandingsWithNames({ gameServerId, moduleId, config, state, categories, endIso, size }) {
  const standings = await computeStandings({ gameServerId, moduleId, config, state, categories, endIso });
  const shown = [];
  for (const category of categories) {
    if (standings[category]) shown.push(...standings[category].slice(0, size));
  }
  await attachNames(shown);
  return standings;
}
