import { takaro, data, axios, checkPermission, TakaroUserError } from '@takaro/helpers';

// The server-list API family (7daystodie-servers.com, rust-servers.net, ...):
//   GET  <base>/api/?object=votes&element=claim&key=K&steamid=S          -> 0 not voted, 1 voted + unclaimed, 2 claimed
//   POST <base>/api/?action=post&object=votes&element=claim&key=K&...    -> 1 claimed now, 0 not claimed
// Both look at the last 24 hours only.
const REQUEST_TIMEOUT_MS = 10000;

export const STATUS = {
  NOT_VOTED: 'not-voted',
  UNCLAIMED: 'unclaimed',
  CLAIMED: 'already-claimed',
  BAD_KEY: 'bad-key',
  UNREACHABLE: 'unreachable',
  UNEXPECTED: 'unexpected',
};

export function fill(template, values) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

export async function getSetting(key, gameServerId) {
  const res = await takaro.settings.settingsControllerGetOne(key, gameServerId);
  return res.data.data.value;
}

export function apiUrl(site) {
  const base = String(site.apiBase)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api$/, '');
  return `${base}/api/`;
}

/** The query parameter the vote site identifies this player by, or null when there is none. */
export function voterIdentity(player, identifyBy) {
  const mode = identifyBy || 'steamId';
  if (mode !== 'username' && player.steamId) return { steamid: player.steamId };
  if (mode !== 'steamId' && player.name) return { username: player.name };
  return null;
}

function describeError(err) {
  if (err?.response) return `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`;
  return `${err?.name ?? 'Error'}: ${err?.message ?? err}`;
}

async function callSite(site, method, params) {
  // The module VM has no URLSearchParams, so the query is built by hand.
  const query = Object.entries({ ...params, key: site.apiKey })
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  const url = `${apiUrl(site)}?${query}`;
  const res = method === 'post'
    ? await axios.post(url, null, { timeout: REQUEST_TIMEOUT_MS })
    : await axios.get(url, { timeout: REQUEST_TIMEOUT_MS });
  return String(res.data).trim();
}

function parseCheck(body) {
  if (body === '0') return STATUS.NOT_VOTED;
  if (body === '1') return STATUS.UNCLAIMED;
  if (body === '2') return STATUS.CLAIMED;
  if (/key not found|invalid key/i.test(body)) return STATUS.BAD_KEY;
  return STATUS.UNEXPECTED;
}

/** Checks one site and, when there is an unclaimed vote, marks it claimed. Never throws. */
export async function checkAndClaim(site, identity) {
  let check;
  try {
    check = parseCheck(await callSite(site, 'get', { object: 'votes', element: 'claim', ...identity }));
  } catch (err) {
    console.error(`vote-rewards: checking ${site.name} failed: ${describeError(err)}`);
    return STATUS.UNREACHABLE;
  }
  console.log(`vote-rewards: ${site.name} check -> ${check}`);
  if (check !== STATUS.UNCLAIMED) return check;

  // The claim call is the guard against double rewards: only the run that flips the vote to claimed gets "1".
  try {
    const body = await callSite(site, 'post', { action: 'post', object: 'votes', element: 'claim', ...identity });
    console.log(`vote-rewards: ${site.name} claim -> ${body}`);
    if (body === '1') return 'claimed-now';
    return body === '0' ? STATUS.CLAIMED : STATUS.UNEXPECTED;
  } catch (err) {
    console.error(`vote-rewards: claiming on ${site.name} failed: ${describeError(err)}`);
    return STATUS.UNREACHABLE;
  }
}

function currencyMultiplier(pog) {
  const perm = checkPermission(pog, 'VOTE_REWARDS_MULTIPLIER');
  if (!perm || typeof perm !== 'object') return 1;
  const count = Number(perm.count);
  return Number.isFinite(count) && count > 1 ? count : 1;
}

// Claimed votes wait in a pending queue (one Takaro variable each) until their reward is fully given.
// A run takes an entry by deleting its variable first: only one run can delete it, so a reward is never
// paid twice. If giving fails, the entry goes back with its progress and is retried on the next vote command.
const PENDING_PREFIX = 'vote_rewards_pending:';

function scope() {
  return { gameServerId: data.gameServerId, playerId: data.player.id, moduleId: data.module.moduleId };
}

/** Adds one claimed vote to the player's pending queue. Returns false when it could not be stored. */
async function addPending(entry) {
  const key = `${PENDING_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await takaro.variable.variableControllerCreate({ key, value: JSON.stringify(entry), ...scope() });
    return true;
  } catch (err) {
    console.error(`vote-rewards: storing the pending reward for ${entry.site} failed: ${describeError(err)}`);
    return false;
  }
}

async function listPending() {
  const { gameServerId, playerId, moduleId } = scope();
  const res = await takaro.variable.variableControllerSearch({
    filters: { gameServerId: [gameServerId], playerId: [playerId], moduleId: [moduleId] },
    search: { key: [PENDING_PREFIX] },
    limit: 100,
  });
  return (res.data.data ?? []).filter((row) => String(row.key).startsWith(PENDING_PREFIX));
}

/** Takes a pending entry so no other run can pay it. Returns null when another run already took it. */
async function takePending(row) {
  try {
    await takaro.variable.variableControllerDelete(row.id);
  } catch (err) {
    console.log(`vote-rewards: pending reward ${row.key} was taken by another run: ${describeError(err)}`);
    return null;
  }
  try {
    return { site: 'the vote site', currencyDone: false, itemsDone: 0, ...JSON.parse(row.value) };
  } catch {
    return { site: 'the vote site', currencyDone: false, itemsDone: 0 };
  }
}

/**
 * Gives one vote's reward, continuing where an earlier try stopped. Updates entry.currencyDone and
 * entry.itemsDone as it goes and throws on the first failure. Returns a short text of what was given.
 */
async function giveReward(entry, config, multiplier, currencyName) {
  const { gameServerId, player } = data;
  const parts = [];

  const currency = Math.floor((config.currency ?? 0) * multiplier);
  if (!entry.currencyDone) {
    if (currency > 0) {
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, player.id, { currency });
    }
    entry.currencyDone = true;
  }
  if (currency > 0) parts.push(`${currency} ${currencyName}`);

  const items = (config.items ?? []).filter((reward) => reward?.item);
  for (let i = 0; i < items.length; i++) {
    const reward = items[i];
    const amount = reward.amount ?? 1;
    if (i >= entry.itemsDone) {
      await takaro.gameserver.gameServerControllerGiveItem(gameServerId, player.id, {
        name: reward.item,
        amount,
        quality: reward.quality ?? '',
      });
      entry.itemsDone = i + 1;
    }
    let itemName = reward.item;
    try {
      itemName = (await takaro.item.itemControllerFindOne(reward.item)).data.data?.name ?? reward.item;
    } catch {
      // Only the display name is missing; the item was given.
    }
    parts.push(`${amount}x ${itemName}`);
  }

  return parts.length ? parts.join(', ') : 'our thanks';
}

/** Pays every pending vote reward of this player. Returns how many were paid in full. */
async function payPending(config, pog, base) {
  const { gameServerId, player } = data;
  let rows;
  try {
    rows = await listPending();
  } catch (err) {
    console.error(`vote-rewards: reading pending rewards failed: ${describeError(err)}`);
    await player.pm('Your vote rewards could not be loaded right now. They are saved, type the vote command again later.');
    return 0;
  }
  if (rows.length === 0) return 0;

  const multiplier = currencyMultiplier(pog);
  const currencyName = config.currency > 0 ? await getSetting('currencyName', gameServerId) : '';
  let paid = 0;
  for (const row of rows) {
    const entry = await takePending(row);
    if (!entry) continue;
    let reward;
    try {
      reward = await giveReward(entry, config, multiplier, currencyName);
    } catch (err) {
      console.error(`vote-rewards: giving the reward for ${entry.site} failed: ${describeError(err)}`);
      const saved = await addPending(entry);
      await player.pm(
        saved
          ? `Your reward for voting on ${entry.site} could not be given right now. It is saved, type the vote command again later.`
          : `Your vote on ${entry.site} was claimed, but the reward could not be given. Please tell an admin.`,
      );
      continue;
    }
    paid++;
    await player.pm(fill(config.rewardMessage, { ...base, site: entry.site, reward }));
    if (config.broadcastMessage) {
      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
        message: fill(config.broadcastMessage, { ...base, site: entry.site }),
      });
    }
  }
  return paid;
}

export async function runVoteCommand() {
  const { gameServerId, player, pog } = data;
  const config = data.module.userConfig;

  if (!checkPermission(pog, 'VOTE_REWARDS_CLAIM')) {
    throw new TakaroUserError('You are not allowed to claim vote rewards on this server.');
  }

  const sites = (config.sites ?? []).filter((site) => site?.apiKey && site?.apiBase);
  if (sites.length === 0) {
    throw new TakaroUserError('Voting is not set up on this server yet. Please tell an admin.');
  }

  const identity = voterIdentity(player, config.identifyBy);
  if (!identity) {
    throw new TakaroUserError(
      'Your vote cannot be checked: this server matches votes by Steam ID and your player has none. Please tell an admin.',
    );
  }

  const prefix = await getSetting('commandPrefix', gameServerId);
  const base = { player: player.name, prefix };

  const results = [];
  for (const site of sites) {
    const status = await checkAndClaim(site, identity);
    if (status === 'claimed-now' && !(await addPending({ site: site.name, currencyDone: false, itemsDone: 0 }))) {
      // The queue is unreachable: give the reward directly, once, so it is not lost.
      results.push({ site, status: 'claimed-unqueued' });
      continue;
    }
    results.push({ site, status });
  }

  let paid = 0;
  for (const { site, status } of results) {
    if (status !== 'claimed-unqueued') continue;
    const entry = { site: site.name, currencyDone: false, itemsDone: 0 };
    try {
      const currencyName = config.currency > 0 ? await getSetting('currencyName', gameServerId) : '';
      const reward = await giveReward(entry, config, currencyMultiplier(pog), currencyName);
      paid++;
      await player.pm(fill(config.rewardMessage, { ...base, site: site.name, reward }));
    } catch (err) {
      console.error(`vote-rewards: giving the reward for ${site.name} failed: ${describeError(err)}`);
      await player.pm(`Your vote on ${site.name} was claimed, but the reward could not be given. Please tell an admin.`);
    }
  }
  paid += await payPending(config, pog, base);

  const claimedAny = results.some((r) => r.status === 'claimed-now' || r.status === 'claimed-unqueued');
  for (const { site, status } of results) {
    const values = { ...base, site: site.name, link: site.voteLink || site.name };
    if (status === STATUS.NOT_VOTED && !claimedAny && paid === 0) {
      await player.pm(fill(config.notVotedMessage, values));
    } else if (status === STATUS.CLAIMED) {
      await player.pm(fill(config.alreadyClaimedMessage, values));
    } else if (status === STATUS.BAD_KEY) {
      await player.pm(`The vote key for ${site.name} is not set up correctly. Please tell an admin.`);
    } else if (status === STATUS.UNREACHABLE) {
      await player.pm(`${site.name} is not responding right now. Your vote is safe, try again in a few minutes.`);
    } else if (status === STATUS.UNEXPECTED) {
      await player.pm(`${site.name} gave an unexpected answer. Try again later or tell an admin.`);
    }
  }
}

export async function runReminder() {
  const { gameServerId } = data;
  const config = data.module.userConfig;
  const sites = (config.sites ?? []).filter((site) => site?.apiKey && site?.apiBase);
  if (sites.length === 0 || !config.reminderMessage) {
    console.log('vote-rewards: no vote sites or reminder message configured, skipping reminder');
    return;
  }
  const prefix = await getSetting('commandPrefix', gameServerId);
  const links = sites.map((site) => site.voteLink || site.name).join(', ');
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message: fill(config.reminderMessage, { links, prefix }),
  });
}
