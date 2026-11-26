import { takaro } from '@takaro/helpers';

const HOUR_MS = 3600000;
const PAGE_SIZE = 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// One variable per player for sign-ups and gifts: two players acting at once never overwrite each other,
// and Takaro's unique (key, server, player, module) index stops a double sign-up or double gift.
export const signupKey = (season) => `santa_signup:${season}`;
export const giftKey = (season) => `santa_gift:${season}`;
export const toldKey = (season) => `santa_told:${season}`;
export const stateKey = (season) => `santa_state:${season}`;

export async function getSetting(key, gameServerId, fallback) {
  try {
    const res = await takaro.settings.settingsControllerGetOne(key, gameServerId);
    return res.data.data.value ?? fallback;
  } catch (err) {
    console.log(`secret-santa: could not read setting ${key}: ${err}`);
    return fallback;
  }
}

export async function textContext(gameServerId) {
  const prefix = await getSetting('commandPrefix', gameServerId, '/');
  const currency = await getSetting('currencyName', gameServerId, 'coins');
  return { prefix, currency };
}

export function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** "12-24" -> "Dec 24". */
export function formatDate(mmdd) {
  const [m, d] = String(mmdd).split('-').map(Number);
  return `${MONTHS[m - 1] ?? '?'} ${d}`;
}

function validDate(mmdd) {
  const m = /^(\d{2})-(\d{2})$/.exec(String(mmdd));
  if (!m) return false;
  const month = Number(m[1]);
  const day = Number(m[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** Returns an error text when the configured dates are unusable, otherwise null. */
export function dateProblem(config) {
  const { signupStart, signupEnd, giftDeadline, revealDate } = config;
  for (const [name, value] of Object.entries({ signupStart, signupEnd, giftDeadline, revealDate })) {
    if (!validDate(value)) return `${name} "${value}" is not a MM-DD date`;
  }
  if (!(signupStart <= signupEnd && signupEnd < giftDeadline && giftDeadline < revealDate)) {
    return 'dates must be in order: signupStart <= signupEnd < giftDeadline < revealDate (all in one year)';
  }
  return null;
}

/** The server's local calendar day (UTC + utcOffsetHours). */
export function localClock(config, nowMs = Date.now()) {
  const local = new Date(nowMs + (Number(config.utcOffsetHours) || 0) * HOUR_MS);
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');
  return { season: local.getUTCFullYear(), today: `${month}-${day}`, hour: local.getUTCHours() };
}

/** Whole days from today until mmdd (same year). */
export function daysUntil(today, mmdd, season) {
  const a = Date.UTC(season, Number(today.slice(0, 2)) - 1, Number(today.slice(3)));
  const b = Date.UTC(season, Number(mmdd.slice(0, 2)) - 1, Number(mmdd.slice(3)));
  return Math.round((b - a) / (24 * HOUR_MS));
}

/**
 * before | signup | pair-due | gifting | closed | reveal-due | done | cancelled
 * "closed" = gift deadline passed, reveal day not reached yet.
 */
export function phaseOf(config, clock, state) {
  if (state?.revealedAt) return 'done';
  if (state?.cancelled) return 'cancelled';
  if (state?.pairs) {
    if (clock.today >= config.revealDate) return 'reveal-due';
    if (clock.today <= config.giftDeadline) return 'gifting';
    return 'closed';
  }
  if (clock.today < config.signupStart) return 'before';
  if (clock.today <= config.signupEnd) return 'signup';
  return 'pair-due';
}

async function searchAll(filters) {
  const all = [];
  for (let page = 0; page < 100; page++) {
    const res = await takaro.variable.variableControllerSearch({ filters, limit: PAGE_SIZE, page });
    const rows = res.data.data;
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

async function findOne(gameServerId, moduleId, key, playerId) {
  const filters = { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] };
  if (playerId) filters.playerId = [playerId];
  const res = await takaro.variable.variableControllerSearch({ filters });
  return res.data.data[0] ?? null;
}

export async function getState(gameServerId, moduleId, season) {
  const row = await findOne(gameServerId, moduleId, stateKey(season));
  if (!row) return { row: null, state: {} };
  return { row, state: parseJson(row.value) ?? {} };
}

export async function saveState(gameServerId, moduleId, season, row, state) {
  const value = JSON.stringify(state);
  if (row) {
    await takaro.variable.variableControllerUpdate(row.id, { value });
    return row;
  }
  const res = await takaro.variable.variableControllerCreate({ key: stateKey(season), value, gameServerId, moduleId });
  return res.data.data;
}

/** [{ row, playerId, name, gameId, at }] sorted by player id. */
export async function getSignups(gameServerId, moduleId, season) {
  const rows = await searchAll({ key: [signupKey(season)], gameServerId: [gameServerId], moduleId: [moduleId] });
  return rows
    .map((row) => ({ row, playerId: row.playerId, ...(parseJson(row.value) ?? {}) }))
    .filter((s) => s.playerId)
    .sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
}

export async function findSignup(gameServerId, moduleId, season, playerId) {
  return findOne(gameServerId, moduleId, signupKey(season), playerId);
}

/** Map giverId -> { row, amount, note, at }. */
export async function getGifts(gameServerId, moduleId, season) {
  const rows = await searchAll({ key: [giftKey(season)], gameServerId: [gameServerId], moduleId: [moduleId] });
  const map = new Map();
  for (const row of rows) {
    const gift = parseJson(row.value);
    if (row.playerId && gift) map.set(row.playerId, { row, ...gift });
  }
  return map;
}

export async function findGift(gameServerId, moduleId, season, playerId) {
  const row = await findOne(gameServerId, moduleId, giftKey(season), playerId);
  return row ? { row, ...(parseJson(row.value) ?? {}) } : null;
}

/**
 * One random cycle through all players: everybody gives to the next one. No one draws themselves,
 * and it works for any count from 2 up (odd counts too).
 */
export function drawPairs(signups) {
  const list = [...signups];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list.map((giver, i) => {
    const receiver = list[(i + 1) % list.length];
    return {
      giver: giver.playerId,
      giverName: giver.name,
      giverGameId: giver.gameId,
      receiver: receiver.playerId,
      receiverName: receiver.name,
      receiverGameId: receiver.gameId,
    };
  });
}

/** Map playerId -> gameId of the players online right now. */
export async function onlinePlayers(gameServerId) {
  const online = new Map();
  for (let page = 0; page < 100; page++) {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], online: [true] },
      limit: PAGE_SIZE,
      page,
    });
    const rows = res.data.data;
    for (const pog of rows) online.set(pog.playerId, pog.gameId);
    if (rows.length < PAGE_SIZE) break;
  }
  return online;
}

export async function broadcast(gameServerId, message) {
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message });
}

export async function pmGameId(gameServerId, gameId, message) {
  try {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message, opts: { recipient: { gameId } } });
  } catch (err) {
    console.log(`secret-santa: PM to ${gameId} failed: ${err}`);
  }
}

export function giftRange(config, currency) {
  const min = Number(config.minGift) || 0;
  const max = Number(config.maxGift) || 0;
  if (max > 0) return `${min} to ${max} ${currency}`;
  return `at least ${min} ${currency}`;
}

export function assignmentLines(config, ctx, receiverName) {
  return [
    `Secret Santa: you are the Secret Santa of ${receiverName}. Keep it secret!`,
    `Send your gift with ${ctx.prefix}santa gift <amount> [note] by ${formatDate(config.giftDeadline)} (${giftRange(config, ctx.currency)}).`,
  ];
}

export function reminderLine(config, ctx, clock, receiverName) {
  const left = daysUntil(clock.today, config.giftDeadline, clock.season);
  const when = left <= 0 ? 'today is the last day' : `${left} day${left === 1 ? '' : 's'} left`;
  return `Secret Santa reminder: send your gift to ${receiverName} with ${ctx.prefix}santa gift <amount> (${when}).`;
}

/**
 * Draws the pairs, or cancels when too few signed up. Returns the new state.
 * Re-reads the state first so a cron run and an admin cannot both draw.
 */
export async function pairNow(gameServerId, mod, clock, ctx) {
  const { moduleId, userConfig: config } = mod;
  const { row, state } = await getState(gameServerId, moduleId, clock.season);
  if (state.pairs || state.cancelled || state.revealedAt) return { state, changed: false };

  const signups = await getSignups(gameServerId, moduleId, clock.season);
  const minPlayers = Math.max(2, Number(config.minParticipants) || 3);
  if (signups.length < minPlayers) {
    const next = { ...state, cancelled: true, cancelledAt: new Date().toISOString(), signups: signups.length };
    await saveState(gameServerId, moduleId, clock.season, row, next);
    if (signups.length > 0) {
      await broadcast(gameServerId, `Secret Santa is cancelled this year: only ${signups.length} player${signups.length === 1 ? '' : 's'} signed up (need ${minPlayers}).`);
    }
    return { state: next, changed: true };
  }

  const pairs = drawPairs(signups);
  const next = { ...state, pairs, pairedAt: new Date().toISOString() };
  await saveState(gameServerId, moduleId, clock.season, row, next);

  await broadcast(gameServerId, `Secret Santa: the names are drawn! ${pairs.length} players take part. Check your PM or type ${ctx.prefix}santa.`);
  const online = await onlinePlayers(gameServerId);
  for (const pair of pairs) {
    const gameId = online.get(pair.giver);
    if (!gameId) continue;
    for (const line of assignmentLines(config, ctx, pair.receiverName)) await pmGameId(gameServerId, gameId, line);
  }
  return { state: next, changed: true };
}

function revealLines(result, ctx) {
  if (result.amount > 0 && !result.fromServer) {
    const lines = [`Merry Christmas! Your Secret Santa was ${result.giverName}. They gave you ${result.amount} ${ctx.currency}.`];
    if (result.note) lines.push(`Note from ${result.giverName}: ${result.note}`);
    return lines;
  }
  if (result.amount > 0) {
    return [`Merry Christmas! Your Secret Santa ${result.giverName} sent no gift, so the server gave you ${result.amount} ${ctx.currency}.`];
  }
  return [`Your Secret Santa this year was ${result.giverName}, but they did not send a gift.`];
}

/** PMs a receiver their reveal once. Safe to call again: the told-variable blocks repeats. */
export async function tellReveal(gameServerId, moduleId, season, result, gameId, ctx) {
  try {
    await takaro.variable.variableControllerCreate({
      key: toldKey(season),
      value: '1',
      gameServerId,
      moduleId,
      playerId: result.receiver,
    });
  } catch {
    return false;
  }
  for (const line of revealLines(result, ctx)) await pmGameId(gameServerId, gameId, line);
  return true;
}

export function revealLinesFor(result, ctx) {
  return revealLines(result, ctx);
}

/** Pays out the held gifts (and the fallback gift), broadcasts the reveal, PMs online receivers. */
export async function revealNow(gameServerId, mod, clock, ctx) {
  const { moduleId, userConfig: config } = mod;
  const { row, state } = await getState(gameServerId, moduleId, clock.season);
  if (!state.pairs || state.revealedAt) return { state, changed: false };

  // Mark revealed before paying anything, so a second run stops here instead of paying twice.
  let current = { ...state, revealedAt: new Date().toISOString() };
  const savedRow = await saveState(gameServerId, moduleId, clock.season, row, current);

  const gifts = await getGifts(gameServerId, moduleId, clock.season);
  const fallback = Number(config.fallbackGift) || 0;
  const results = [];
  for (const pair of state.pairs) {
    const gift = gifts.get(pair.giver);
    const amount = gift ? Number(gift.amount) || 0 : fallback;
    if (amount > 0) {
      try {
        await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, pair.receiver, { currency: amount });
      } catch (err) {
        console.log(`secret-santa: could not pay ${amount} to ${pair.receiverName}: ${err}`);
      }
    }
    results.push({
      giver: pair.giver,
      giverName: pair.giverName,
      receiver: pair.receiver,
      receiverName: pair.receiverName,
      amount,
      fromServer: !gift,
      note: gift?.note || '',
    });
  }
  current = { ...current, results };
  await saveState(gameServerId, moduleId, clock.season, savedRow, current);

  const sent = results.filter((r) => !r.fromServer).length;
  await broadcast(gameServerId, `Merry Christmas! Secret Santa reveal: ${sent} of ${results.length} Santas sent a gift.`);
  const maxLines = Math.max(0, Number(config.revealBroadcastLines) || 0);
  for (const r of results.slice(0, maxLines)) {
    await broadcast(gameServerId, `${r.giverName} was the Secret Santa of ${r.receiverName}.`);
  }
  if (results.length > maxLines) {
    const more = results.length - maxLines;
    await broadcast(gameServerId, `${maxLines > 0 ? `...and ${more} more.` : ''} Type ${ctx.prefix}santa to see yours.`.trim());
  }

  const online = await onlinePlayers(gameServerId);
  for (const r of results) {
    const gameId = online.get(r.receiver);
    if (gameId) await tellReveal(gameServerId, moduleId, clock.season, r, gameId, ctx);
  }
  return { state: current, changed: true };
}

/** Deletes every variable of a season. Refunds held gifts when the reveal has not happened yet. */
export async function resetSeason(gameServerId, mod, clock) {
  const { moduleId } = mod;
  const { row, state } = await getState(gameServerId, moduleId, clock.season);
  const gifts = await getGifts(gameServerId, moduleId, clock.season);
  let refunded = 0;
  for (const [giverId, gift] of gifts) {
    if (!state.revealedAt && Number(gift.amount) > 0) {
      try {
        await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, giverId, { currency: Number(gift.amount) });
        refunded++;
      } catch (err) {
        console.log(`secret-santa: refund to ${giverId} failed: ${err}`);
      }
    }
  }
  const rows = [
    ...(row ? [row] : []),
    ...[...gifts.values()].map((g) => g.row),
    ...(await searchAll({ key: [signupKey(clock.season)], gameServerId: [gameServerId], moduleId: [moduleId] })),
    ...(await searchAll({ key: [toldKey(clock.season)], gameServerId: [gameServerId], moduleId: [moduleId] })),
  ];
  for (const r of rows) {
    try {
      await takaro.variable.variableControllerDelete(r.id);
    } catch (err) {
      console.log(`secret-santa: could not delete ${r.key}: ${err}`);
    }
  }
  return { refunded, deleted: rows.length };
}
