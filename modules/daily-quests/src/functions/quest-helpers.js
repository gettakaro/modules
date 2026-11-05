import { takaro, checkPermission } from '@takaro/helpers';

export const STATE_KEY = 'dq_state';
export const QUEST_TYPES = ['kill', 'death', 'playtime', 'shop', 'currency', 'chat', 'command'];
// A playtime tick only counts when the previous one is this recent; longer gaps mean the player was away.
export const MAX_TICK_GAP_MS = 15 * 60 * 1000;

/** The quest day a moment belongs to: a UTC date that rolls over at `resetHourUtc` instead of midnight. */
export function dayKey(now, resetHourUtc) {
  const shifted = new Date(now.getTime() - (resetHourUtc || 0) * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** Milliseconds until the next quest reset. */
export function msUntilReset(now, resetHourUtc) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), resetHourUtc || 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Builds the per-execution context shared by every component. Settings are read lazily and cached. */
export function createContext(data) {
  const ctx = {
    gameServerId: data.gameServerId,
    moduleId: data.module.moduleId,
    config: data.module.userConfig,
    now: new Date(),
    _settings: {},
    _pogs: {},
    _commandNames: undefined,
  };
  if (data.pog && data.player) ctx._pogs[data.player.id] = data.pog;
  return ctx;
}

export async function getSetting(ctx, key, fallback) {
  if (!(key in ctx._settings)) {
    try {
      const res = await takaro.settings.settingsControllerGetOne(key, ctx.gameServerId);
      ctx._settings[key] = res.data.data.value || fallback;
    } catch (err) {
      console.error(`daily-quests: could not read setting ${key}: ${err}`);
      ctx._settings[key] = fallback;
    }
  }
  return ctx._settings[key];
}

export async function getPog(ctx, playerId) {
  if (!ctx._pogs[playerId]) {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(ctx.gameServerId, playerId);
    ctx._pogs[playerId] = res.data.data;
  }
  return ctx._pogs[playerId];
}

export async function pm(ctx, playerId, message) {
  try {
    const pog = await getPog(ctx, playerId);
    await takaro.gameserver.gameServerControllerSendMessage(ctx.gameServerId, {
      message,
      opts: { recipient: { gameId: pog.gameId } },
    });
  } catch (err) {
    console.error(`daily-quests: failed to PM player ${playerId}: ${err}`);
  }
}

// ---------- state ----------

async function findStateVariable(ctx, playerId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: {
      key: [STATE_KEY],
      gameServerId: [ctx.gameServerId],
      moduleId: [ctx.moduleId],
      playerId: [playerId],
    },
  });
  return res.data.data.length > 0 ? res.data.data[0] : null;
}

export async function loadState(ctx, playerId) {
  const variable = await findStateVariable(ctx, playerId);
  let state = null;
  if (variable) {
    try {
      state = JSON.parse(variable.value);
    } catch (err) {
      console.error(`daily-quests: corrupt state for player ${playerId}, starting fresh: ${err}`);
    }
  }
  return { variableId: variable ? variable.id : null, state };
}

export async function saveState(ctx, playerId, record) {
  const value = JSON.stringify(record.state);
  if (record.variableId) {
    await takaro.variable.variableControllerUpdate(record.variableId, { value });
  } else {
    const res = await takaro.variable.variableControllerCreate({
      key: STATE_KEY,
      value,
      gameServerId: ctx.gameServerId,
      moduleId: ctx.moduleId,
      playerId,
    });
    record.variableId = res.data.data.id;
  }
}

// ---------- quest pool ----------

/** Names of every command installed on this game server, or null when they can't be listed (then nothing is filtered). */
async function installedCommandNames(ctx) {
  if (ctx._commandNames !== undefined) return ctx._commandNames;
  try {
    const names = new Set();
    let page = 0;
    while (true) {
      const res = await takaro.module.moduleInstallationsControllerGetInstalledModules({
        filters: { gameserverId: [ctx.gameServerId] },
        page,
        limit: 100,
      });
      for (const inst of res.data.data) {
        for (const cmd of (inst.version && inst.version.commands) || []) {
          names.add(String(cmd.name).toLowerCase());
          if (cmd.trigger) names.add(String(cmd.trigger).toLowerCase());
        }
      }
      if (res.data.data.length < 100) break;
      page++;
    }
    ctx._commandNames = names;
  } catch (err) {
    console.error(`daily-quests: could not list installed commands, not filtering command quests: ${err}`);
    ctx._commandNames = null;
  }
  return ctx._commandNames;
}

export function splitList(filter) {
  return String(filter || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Quest definitions that may be handed out on this server right now. */
export async function eligibleQuests(ctx) {
  const types = ctx.config.enabledTypes || {};
  const pool = (ctx.config.quests || []).filter(
    (q) =>
      q &&
      q.id &&
      q.enabled !== false &&
      QUEST_TYPES.includes(q.type) &&
      types[q.type] !== false &&
      Number(q.target) > 0,
  );
  const out = [];
  for (const q of pool) {
    if (q.type === 'command') {
      const wanted = splitList(q.filter);
      if (wanted.length === 0) continue;
      const names = await installedCommandNames(ctx);
      if (names && !wanted.some((w) => names.has(w))) {
        console.log(`daily-quests: skipping quest ${q.id}, none of the commands [${wanted.join(', ')}] are installed`);
        continue;
      }
    }
    out.push(q);
  }
  return out;
}

/** Weighted random pick of `count` distinct quests, skipping ids in `excludeIds`. */
export function pickQuests(pool, count, excludeIds = []) {
  let candidates = pool.filter((q) => !excludeIds.includes(q.id));
  const picked = [];
  while (picked.length < count && candidates.length > 0) {
    const total = candidates.reduce((sum, q) => sum + Math.max(0, Number(q.weight ?? 1)), 0);
    let idx = 0;
    if (total > 0) {
      let roll = Math.random() * total;
      for (idx = 0; idx < candidates.length - 1; idx++) {
        roll -= Math.max(0, Number(candidates[idx].weight ?? 1));
        if (roll < 0) break;
      }
    } else {
      idx = Math.floor(Math.random() * candidates.length);
    }
    picked.push(candidates[idx]);
    candidates = candidates.filter((_, i) => i !== idx);
  }
  return picked;
}

/** A frozen copy of a definition, so editing the pool mid-day never changes a quest a player already has. */
export function snapshot(def) {
  return {
    id: def.id,
    type: def.type,
    description: def.description || '',
    target: Math.floor(Number(def.target)),
    filter: def.filter || '',
    rewardCurrency: Math.max(0, Math.floor(Number(def.rewardCurrency || 0))),
    rewardItems: Array.isArray(def.rewardItems) ? def.rewardItems : [],
    progress: 0,
    done: false,
    milestone: 0,
  };
}

async function permissionCount(ctx, playerId, permission) {
  try {
    const pog = await getPog(ctx, playerId);
    const perm = checkPermission(pog, permission);
    return perm && typeof perm === 'object' && Number(perm.count) > 0 ? Number(perm.count) : 0;
  } catch (err) {
    console.error(`daily-quests: could not check ${permission} for ${playerId}: ${err}`);
    return 0;
  }
}

export async function questsPerDayFor(ctx, playerId) {
  return (ctx.config.questsPerDay || 3) + (await permissionCount(ctx, playerId, 'DAILY_QUESTS_EXTRA_QUESTS'));
}

export async function rerollsPerDayFor(ctx, playerId) {
  return (ctx.config.rerollsPerDay ?? 1) + (await permissionCount(ctx, playerId, 'DAILY_QUESTS_EXTRA_REROLLS'));
}

/**
 * Loads the player's state and hands out today's quests when the stored day is stale.
 * Returns the record plus `fresh` (true when quests were just assigned). The caller saves.
 */
export async function ensureToday(ctx, playerId) {
  const record = await loadState(ctx, playerId);
  const today = dayKey(ctx.now, ctx.config.resetHourUtc);
  if (record.state && record.state.day === today) {
    record.fresh = false;
    return record;
  }
  const pool = await eligibleQuests(ctx);
  const count = await questsPerDayFor(ctx, playerId);
  const quests = pickQuests(pool, count).map(snapshot);
  record.state = {
    day: today,
    quests,
    rerollsUsed: 0,
    bonusPaid: false,
    lastTick: quests.some((q) => q.type === 'playtime') ? ctx.now.toISOString() : null,
    ignoreCredits: [],
  };
  record.fresh = true;
  return record;
}

// ---------- texts ----------

export async function describeQuest(ctx, quest) {
  const prefix = await getSetting(ctx, 'commandPrefix', '/');
  const currency = await getSetting(ctx, 'currencyName', 'coins');
  const text = quest.description || defaultDescription(quest);
  return text
    .replace(/\{target\}/g, String(quest.target))
    .replace(/\{filter\}/g, quest.filter)
    .replace(/\{prefix\}/g, prefix)
    .replace(/\{currency\}/g, currency);
}

function defaultDescription(quest) {
  switch (quest.type) {
    case 'kill':
      return quest.filter ? 'Kill {target} x {filter}' : 'Kill {target} enemies';
    case 'death':
      return 'Die {target} times';
    case 'playtime':
      return 'Play {target} minutes';
    case 'shop':
      return quest.filter ? 'Buy {filter} in the shop {target} times' : 'Buy something in the shop ({target}x)';
    case 'currency':
      return 'Earn {target} {currency}';
    case 'chat':
      return 'Send {target} chat messages';
    case 'command':
      return 'Use {prefix}{filter} ({target}x)';
    default:
      return '{target}x';
  }
}

export async function rewardText(ctx, quest) {
  const parts = [];
  if (quest.rewardCurrency > 0) {
    parts.push(`${quest.rewardCurrency} ${await getSetting(ctx, 'currencyName', 'coins')}`);
  }
  if (quest.rewardItems.length > 0) parts.push(`${quest.rewardItems.length} item reward(s)`);
  return parts.length ? parts.join(' + ') : 'no reward';
}

// ---------- progress & rewards ----------

async function itemLabel(itemId) {
  try {
    const res = await takaro.item.itemControllerFindOne(itemId);
    return res.data.data.name || itemId;
  } catch {
    return itemId;
  }
}

async function payQuest(ctx, playerId, quest) {
  const currencyName = await getSetting(ctx, 'currencyName', 'coins');
  const got = [];
  if (quest.rewardCurrency > 0) {
    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServerId, playerId, {
        currency: quest.rewardCurrency,
      });
      got.push(`${quest.rewardCurrency} ${currencyName}`);
    } catch (err) {
      console.error(`daily-quests: currency reward failed for ${playerId}: ${err}`);
      await pm(ctx, playerId, `Could not pay ${quest.rewardCurrency} ${currencyName} (is the economy enabled?). Ask an admin.`);
    }
  }
  for (const reward of quest.rewardItems) {
    if (!reward || !reward.item) continue;
    const amount = Math.max(1, Math.floor(Number(reward.amount || 1)));
    const label = await itemLabel(reward.item);
    try {
      await takaro.gameserver.gameServerControllerGiveItem(ctx.gameServerId, playerId, {
        name: reward.item,
        amount,
        quality: reward.quality ?? '',
      });
      got.push(`${amount}x ${label}`);
    } catch (err) {
      console.error(`daily-quests: item reward ${reward.item} failed for ${playerId}: ${err}`);
      await pm(ctx, playerId, `Could not give ${amount}x ${label} (are you online?). Ask an admin.`);
    }
  }
  return got;
}

/**
 * Adds `amount` progress to every open quest of `type` that `matches`, then saves, announces and pays.
 * `matches(quest)` may be async. Returns true when anything changed.
 * `options.record` reuses a record the caller already loaded (via ensureToday); `options.dirty` forces a save.
 */
export async function trackProgress(ctx, playerId, type, amount, matches = () => true, options = {}) {
  if (!playerId) return false;
  if (!options.record && !(amount > 0)) return false;
  if ((ctx.config.enabledTypes || {})[type] === false && !options.record) return false;

  const record = options.record || (await ensureToday(ctx, playerId));
  const state = record.state;
  const milestones = (ctx.config.milestonePercents || []).filter((p) => p > 0 && p < 100).sort((a, b) => a - b);
  const messages = [];
  const completed = [];
  let progressed = false;

  for (const quest of state.quests) {
    if (quest.done || quest.type !== type || !(amount > 0)) continue;
    if (!(await matches(quest))) continue;
    quest.progress = Math.min(quest.target, (quest.progress || 0) + amount);
    progressed = true;
    if (quest.progress >= quest.target) {
      quest.done = true;
      completed.push(quest);
      continue;
    }
    const pct = (quest.progress / quest.target) * 100;
    const reached = milestones.filter((p) => pct >= p && p > (quest.milestone || 0));
    if (reached.length > 0) {
      quest.milestone = reached[reached.length - 1];
      messages.push(`Quest progress: ${await describeQuest(ctx, quest)} - ${Math.floor(quest.progress)}/${quest.target}`);
    }
  }

  // Remember our own payouts so the currency-added events they cause don't count toward "earn currency" quests.
  for (const quest of completed) {
    if (quest.rewardCurrency > 0) state.ignoreCredits.push(quest.rewardCurrency);
  }
  const allDone = state.quests.length > 0 && state.quests.every((q) => q.done);
  const bonus = Math.max(0, Math.floor(Number(ctx.config.allCompleteBonus || 0)));
  const payBonus = allDone && !state.bonusPaid && completed.length > 0;
  if (payBonus) {
    state.bonusPaid = true;
    if (bonus > 0) state.ignoreCredits.push(bonus);
  }
  state.ignoreCredits = state.ignoreCredits.slice(-20);

  if (!record.fresh && !progressed && !options.dirty) return false;
  // Persist before paying, so a failure or a racing event can never pay the same quest twice.
  await saveState(ctx, playerId, record);

  if (record.fresh) {
    const prefix = await getSetting(ctx, 'commandPrefix', '/');
    await pm(ctx, playerId, `New daily quests are ready! Type ${prefix}quests to see them.`);
  }
  for (const message of messages) await pm(ctx, playerId, message);
  for (const quest of completed) {
    const got = await payQuest(ctx, playerId, quest);
    const suffix = got.length ? ` Reward: ${got.join(', ')}.` : '';
    await pm(ctx, playerId, `Quest complete: ${await describeQuest(ctx, quest)}!${suffix}`);
  }
  if (payBonus) {
    let bonusText = '';
    if (bonus > 0) {
      try {
        await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServerId, playerId, {
          currency: bonus,
        });
        bonusText = ` Bonus: ${bonus} ${await getSetting(ctx, 'currencyName', 'coins')}.`;
      } catch (err) {
        console.error(`daily-quests: bonus failed for ${playerId}: ${err}`);
      }
    }
    await pm(ctx, playerId, `All daily quests done!${bonusText} New quests after the daily reset.`);
  }
  return true;
}

/** Text lines for the `quests` command and the reset announcement. */
export async function questLines(ctx, state) {
  const lines = [];
  for (let i = 0; i < state.quests.length; i++) {
    const q = state.quests[i];
    const desc = await describeQuest(ctx, q);
    if (q.done) {
      lines.push(`${i + 1}. [DONE] ${desc}`);
    } else {
      lines.push(`${i + 1}. ${desc} - ${Math.floor(q.progress || 0)}/${q.target} (${await rewardText(ctx, q)})`);
    }
  }
  return lines;
}
