import { takaro, checkPermission } from '@takaro/helpers';

export const KEYS = {
  nextAt: 'lucky_drop_next_at',
  positions: 'lucky_drop_positions',
  session: 'lucky_drop_session',
  race: 'lucky_drop_race',
  history: 'lucky_drop_history',
  claimPrefix: 'lucky_drop_claim_',
};

export const PERMS = {
  eligible: 'LUCKY_DROP_ELIGIBLE',
  vip: 'LUCKY_DROP_VIP_WEIGHT',
  admin: 'LUCKY_DROP_ADMIN',
};

// Positions closer than this (in game units) count as "did not move".
const AFK_DISTANCE = 1;

// ─── Variables ──────────────────────────────────────────────────────────────

async function findVariable(gameServerId, moduleId, key, playerId) {
  const filters = { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] };
  if (playerId) filters.playerId = [playerId];
  const res = await takaro.variable.variableControllerSearch({ filters });
  return res.data.data[0] ?? null;
}

export async function getVariable(gameServerId, moduleId, key, playerId) {
  const row = await findVariable(gameServerId, moduleId, key, playerId);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export async function setVariable(gameServerId, moduleId, key, value, playerId) {
  const serialized = JSON.stringify(value);
  const row = await findVariable(gameServerId, moduleId, key, playerId);
  if (row) {
    await takaro.variable.variableControllerUpdate(row.id, { value: serialized });
    return;
  }
  const body = { key, value: serialized, gameServerId, moduleId };
  if (playerId) body.playerId = playerId;
  await takaro.variable.variableControllerCreate(body);
}

export async function deleteVariable(gameServerId, moduleId, key) {
  const row = await findVariable(gameServerId, moduleId, key);
  if (row) await takaro.variable.variableControllerDelete(row.id);
}

/** All per-player session-start rows of this installation, as a map playerId -> ms timestamp. */
export async function getSessionStarts(gameServerId, moduleId) {
  const starts = {};
  const limit = 100;
  for (let page = 0; page < 100; page++) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { key: [KEYS.session], gameServerId: [gameServerId], moduleId: [moduleId] },
      page,
      limit,
    });
    for (const row of res.data.data) {
      const ms = new Date(JSON.parse(row.value)).getTime();
      if (row.playerId && Number.isFinite(ms)) starts[row.playerId] = ms;
    }
    if (res.data.data.length < limit) break;
  }
  return starts;
}

// ─── Settings / players ─────────────────────────────────────────────────────

export async function getSetting(gameServerId, key, fallback) {
  try {
    const res = await takaro.settings.settingsControllerGetOne(key, gameServerId);
    return res.data.data.value ?? fallback;
  } catch (err) {
    console.log(`luckyDrop: could not read setting ${key}, using ${fallback}`);
    return fallback;
  }
}

export async function getOnlinePogs(gameServerId) {
  let all = [];
  const limit = 100;
  for (let page = 0; page < 100; page++) {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], online: [true] },
      page,
      limit,
    });
    all = all.concat(res.data.data);
    if (res.data.data.length < limit) break;
  }
  return all;
}

export async function getPlayerName(playerId) {
  try {
    const res = await takaro.player.playerControllerGetOne(playerId);
    return res.data.data.name;
  } catch {
    return 'Someone';
  }
}

// ─── Picking ────────────────────────────────────────────────────────────────

/** Weighted pick. `weightOf` returns a number; entries with weight <= 0 never win. */
export function weightedPick(entries, weightOf) {
  const weighted = entries.map((entry) => ({ entry, weight: Math.max(0, Number(weightOf(entry)) || 0) }));
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  if (total <= 0) return null;
  let roll = Math.random() * total;
  for (const w of weighted) {
    if (w.weight <= 0) continue;
    if (roll < w.weight) return w.entry;
    roll -= w.weight;
  }
  // Floating point edge: return the last entry that can win.
  return weighted.filter((w) => w.weight > 0).pop().entry;
}

/** Reward tiers that can actually give something. Currency only counts when the economy is on. */
export function usableTiers(tiers, economyEnabled) {
  return (tiers || [])
    .map((tier) => ({
      rarity: tier.rarity,
      weight: tier.weight,
      currency: economyEnabled ? Math.max(0, Math.floor(tier.currency || 0)) : 0,
      items: (tier.items || []).filter((i) => i && i.item),
    }))
    .filter((tier) => tier.weight > 0 && (tier.currency > 0 || tier.items.length > 0));
}

export async function pickTier(gameServerId, config) {
  const economyEnabled = (await getSetting(gameServerId, 'economyEnabled', 'false')) === 'true';
  const tiers = usableTiers(config.rewards, economyEnabled);
  if (tiers.length === 0) {
    console.error(
      `luckyDrop: no usable reward in the reward table (economyEnabled=${economyEnabled}). ` +
        'Add items, or enable the economy for currency rewards.',
    );
    return null;
  }
  return weightedPick(tiers, (t) => t.weight);
}

function moved(prev, pog) {
  const dx = pog.positionX - prev.x;
  const dy = pog.positionY - prev.y;
  const dz = pog.positionZ - prev.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) >= AFK_DISTANCE;
}

function hasPosition(pog) {
  return [pog.positionX, pog.positionY, pog.positionZ].every((v) => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Compares positions with the previous tick and stores the new ones.
 * Returns the set of playerIds that did not move (AFK).
 */
export async function trackPositions(gameServerId, moduleId, pogs) {
  const prev = (await getVariable(gameServerId, moduleId, KEYS.positions)) || {};
  const next = {};
  const afk = new Set();
  for (const pog of pogs) {
    if (!hasPosition(pog)) continue;
    next[pog.playerId] = { x: pog.positionX, y: pog.positionY, z: pog.positionZ };
    const before = prev[pog.playerId];
    if (before && !moved(before, pog)) afk.add(pog.playerId);
  }
  await setVariable(gameServerId, moduleId, KEYS.positions, next);
  return afk;
}

/** Players online without a session record get one now (e.g. online before the module was installed). */
export async function ensureSessions(gameServerId, moduleId, pogs, starts, nowMs) {
  for (const pog of pogs) {
    if (starts[pog.playerId] !== undefined) continue;
    starts[pog.playerId] = nowMs;
    await setVariable(gameServerId, moduleId, KEYS.session, new Date(nowMs).toISOString(), pog.playerId);
  }
}

export function vipMultiplier(pog) {
  const perm = checkPermission(pog, PERMS.vip);
  if (!perm) return 1;
  const count = Number(perm.count);
  return Number.isFinite(count) && count > 0 ? count : 1;
}

export function eligiblePogs(pogs, { afk, starts, minSessionMinutes, nowMs }) {
  return pogs.filter((pog) => {
    if (!checkPermission(pog, PERMS.eligible)) return false;
    if (afk && afk.has(pog.playerId)) return false;
    if (minSessionMinutes > 0) {
      const start = starts[pog.playerId];
      if (start === undefined || nowMs - start < minSessionMinutes * 60000) return false;
    }
    return true;
  });
}

// ─── Rewards ────────────────────────────────────────────────────────────────

async function itemName(itemId) {
  try {
    const res = await takaro.item.itemControllerFindOne(itemId);
    return res.data.data.name || itemId;
  } catch {
    return itemId;
  }
}

export async function describeTier(tier, currencyName) {
  const parts = [];
  if (tier.currency > 0) parts.push(`${tier.currency} ${currencyName}`);
  for (const item of tier.items) {
    parts.push(`${item.amount || 1}x ${await itemName(item.item)}`);
  }
  return parts.join(', ');
}

/** Gives the tier's reward. Returns a list of parts that failed (empty = all delivered). */
export async function giveTier(gameServerId, playerId, tier) {
  const failed = [];
  if (tier.currency > 0) {
    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, {
        currency: tier.currency,
      });
    } catch (err) {
      console.error(`luckyDrop: adding ${tier.currency} currency to ${playerId} failed`, err);
      failed.push('currency');
    }
  }
  for (const item of tier.items) {
    try {
      await takaro.gameserver.gameServerControllerGiveItem(gameServerId, playerId, {
        name: item.item,
        amount: item.amount || 1,
        quality: item.quality ?? '',
      });
    } catch (err) {
      console.error(`luckyDrop: giving item ${item.item} to ${playerId} failed`, err);
      failed.push(item.item);
    }
  }
  return failed;
}

export function fill(template, values) {
  return String(template || '').replace(/\{(\w+)\}/g, (match, key) =>
    values[key] !== undefined ? String(values[key]) : match,
  );
}

export async function broadcast(gameServerId, message) {
  if (!message) return;
  try {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message });
  } catch (err) {
    console.error('luckyDrop: broadcast failed', err);
  }
}

export async function pm(gameServerId, gameId, message) {
  try {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message,
      opts: { recipient: { gameId } },
    });
  } catch (err) {
    console.error('luckyDrop: pm failed', err);
  }
}

/**
 * Gives the reward to a winner, announces it and records it.
 * `winner` = { playerId, gameId, name }.
 */
export async function awardDrop({ gameServerId, moduleId, config, tier, winner, mode, nowMs }) {
  const currencyName = await getSetting(gameServerId, 'currencyName', 'coins');
  const reward = await describeTier(tier, currencyName);
  const failed = await giveTier(gameServerId, winner.playerId, tier);
  await broadcast(gameServerId, fill(config.dropMessage, { player: winner.name, rarity: tier.rarity, reward }));
  if (failed.length > 0 && winner.gameId) {
    await pm(
      gameServerId,
      winner.gameId,
      'Part of your lucky drop could not be delivered. Please contact an admin.',
    );
  }
  await recordDrop(gameServerId, moduleId, config, {
    at: new Date(nowMs).toISOString(),
    player: winner.name,
    playerId: winner.playerId,
    rarity: tier.rarity,
    reward,
    mode,
    failed: failed.length > 0,
  });
  console.log(`luckyDrop: ${winner.name} won ${tier.rarity} (${reward}) via ${mode}`);
  return reward;
}

export async function recordDrop(gameServerId, moduleId, config, entry) {
  const history = (await getVariable(gameServerId, moduleId, KEYS.history)) || { total: 0, byRarity: {}, recent: [] };
  history.total = (history.total || 0) + 1;
  history.byRarity = history.byRarity || {};
  history.byRarity[entry.rarity] = (history.byRarity[entry.rarity] || 0) + 1;
  history.recent = [entry, ...(history.recent || [])].slice(0, config.historySize || 20);
  await setVariable(gameServerId, moduleId, KEYS.history, history);
}

// ─── Scheduling ─────────────────────────────────────────────────────────────

export function nextDropAt(config, nowMs) {
  const interval = Number(config.dropIntervalMinutes) || 45;
  const jitter = Math.max(0, Number(config.jitterMinutes) || 0);
  const offset = jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0;
  const minutes = Math.max(1, interval + offset);
  return nowMs + Math.round(minutes * 60000);
}

export async function scheduleNext(gameServerId, moduleId, config, nowMs) {
  const at = nextDropAt(config, nowMs);
  await setVariable(gameServerId, moduleId, KEYS.nextAt, new Date(at).toISOString());
  return at;
}

// ─── Running a drop ─────────────────────────────────────────────────────────

/**
 * Runs one drop in the configured mode. Returns a short status string for logs/admins.
 * `opts.pogs`, `opts.afk`, `opts.starts` can be passed when the caller already has them.
 */
export async function runDrop({ gameServerId, moduleId, config, nowMs, pogs, afk, starts }) {
  const tier = await pickTier(gameServerId, config);
  if (!tier) return 'no usable reward configured (add items or enable the economy)';

  if (config.mode === 'claimRace') {
    const prefix = await getSetting(gameServerId, 'commandPrefix', '/');
    const currencyName = await getSetting(gameServerId, 'currencyName', 'coins');
    const reward = await describeTier(tier, currencyName);
    const seconds = config.claimWindowSeconds || 30;
    const race = {
      id: `${nowMs}-${Math.floor(Math.random() * 1e9)}`,
      tier,
      reward,
      startedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + seconds * 1000).toISOString(),
    };
    await setVariable(gameServerId, moduleId, KEYS.race, race);
    await broadcast(gameServerId, fill(config.claimAnnounceMessage, { rarity: tier.rarity, reward, prefix, seconds }));
    return `claim race started (${tier.rarity}: ${reward})`;
  }

  const online = pogs || (await getOnlinePogs(gameServerId));
  const candidates = eligiblePogs(online, {
    afk: config.excludeAfk ? afk : null,
    starts: starts || {},
    minSessionMinutes: starts ? config.minSessionMinutes || 0 : 0,
    nowMs,
  });
  const chosen = weightedPick(candidates, vipMultiplier);
  if (!chosen) return 'no eligible player online (permission, session time or AFK)';

  const name = await getPlayerName(chosen.playerId);
  const reward = await awardDrop({
    gameServerId,
    moduleId,
    config,
    tier,
    winner: { playerId: chosen.playerId, gameId: chosen.gameId, name },
    mode: 'random',
    nowMs,
  });
  return `${name} won ${tier.rarity}: ${reward}`;
}

/** Closes a claim race whose window passed. Returns true when a race is still running. */
export async function closeExpiredRace(gameServerId, moduleId, config, nowMs) {
  const race = await getVariable(gameServerId, moduleId, KEYS.race);
  if (!race) return false;
  if (new Date(race.expiresAt).getTime() > nowMs) return true;
  await deleteVariable(gameServerId, moduleId, KEYS.race);
  await broadcast(gameServerId, fill(config.claimExpiredMessage, { rarity: race.tier.rarity, reward: race.reward }));
  console.log(`luckyDrop: claim race ${race.id} expired unclaimed`);
  return false;
}
