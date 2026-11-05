import { takaro } from '@takaro/helpers';

export const ACTIVE_POLL_KEY = 'polls_active';
export const LAST_POLL_KEY = 'polls_last';
// Votes are one variable per player (key + playerId), so two players voting at once never overwrite each other.
export const voteKey = (pollId) => `polls_vote:${pollId}`;

const PAGE_SIZE = 100;

export async function getSetting(key, gameServerId, fallback) {
  try {
    const res = await takaro.settings.settingsControllerGetOne(key, gameServerId);
    return res.data.data.value ?? fallback;
  } catch (err) {
    console.log(`polls: could not read setting ${key}: ${err}`);
    return fallback;
  }
}

async function findModuleVariable(gameServerId, moduleId, key) {
  const res = await takaro.variable.variableControllerSearch({
    filters: { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] },
  });
  return res.data.data[0] ?? null;
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Returns { variable, poll } for the running poll, or null when there is none. */
export async function getActivePoll(gameServerId, moduleId) {
  const variable = await findModuleVariable(gameServerId, moduleId, ACTIVE_POLL_KEY);
  if (!variable) return null;
  const poll = parseJson(variable.value);
  if (!poll || !Array.isArray(poll.options)) {
    console.log('polls: active poll variable is corrupt, removing it');
    await takaro.variable.variableControllerDelete(variable.id);
    return null;
  }
  return { variable, poll };
}

export async function getLastPoll(gameServerId, moduleId) {
  const variable = await findModuleVariable(gameServerId, moduleId, LAST_POLL_KEY);
  return variable ? parseJson(variable.value) : null;
}

async function setModuleVariable(gameServerId, moduleId, key, value) {
  const existing = await findModuleVariable(gameServerId, moduleId, key);
  const serialized = JSON.stringify(value);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
  } else {
    await takaro.variable.variableControllerCreate({ key, value: serialized, gameServerId, moduleId });
  }
}

export async function createActivePoll(gameServerId, moduleId, poll) {
  await takaro.variable.variableControllerCreate({
    key: ACTIVE_POLL_KEY,
    value: JSON.stringify(poll),
    gameServerId,
    moduleId,
  });
}

/** All vote variables of a poll (paged, sequential requests). */
export async function getVotes(gameServerId, moduleId, pollId) {
  const all = [];
  for (let page = 0; page < 100; page++) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { key: [voteKey(pollId)], gameServerId: [gameServerId], moduleId: [moduleId] },
      limit: PAGE_SIZE,
      page,
    });
    const rows = res.data.data;
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

export async function findPlayerVote(gameServerId, moduleId, pollId, playerId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: { key: [voteKey(pollId)], gameServerId: [gameServerId], moduleId: [moduleId], playerId: [playerId] },
  });
  return res.data.data[0] ?? null;
}

/** Counts per option (0-based), total and the stored votes. Votes for unknown options are ignored. */
export async function tally(gameServerId, moduleId, poll) {
  const votes = await getVotes(gameServerId, moduleId, poll.id);
  const counts = poll.options.map(() => 0);
  // Two quick pollvote calls can race and create two rows for one player: count only the newest.
  const latest = new Map();
  for (const v of votes) {
    const who = v.playerId ?? v.id;
    const prev = latest.get(who);
    if (!prev || String(v.updatedAt ?? '') > String(prev.updatedAt ?? '')) latest.set(who, v);
  }
  const voterIds = [];
  for (const v of latest.values()) {
    const idx = Number(parseJson(v.value));
    if (Number.isInteger(idx) && idx >= 0 && idx < counts.length) {
      counts[idx]++;
      if (v.playerId) voterIds.push(v.playerId);
    }
  }
  const total = counts.reduce((a, b) => a + b, 0);
  return { counts, total, voterIds, votes };
}

export function formatResultLines(options, counts, total) {
  return options.map((opt, i) => {
    const pct = total > 0 ? Math.round((counts[i] / total) * 100) : 0;
    return `${i + 1}. ${opt} - ${counts[i]} vote${counts[i] === 1 ? '' : 's'} (${pct}%)`;
  });
}

/** Winner text, or null when nobody voted. Ties list every top option. */
export function winnerText(options, counts, total) {
  if (total === 0) return null;
  const max = Math.max(...counts);
  const top = options.filter((_, i) => counts[i] === max);
  return top.length === 1 ? `Winner: ${top[0]}` : `Tie between: ${top.join(', ')}`;
}

export function formatRemaining(endsAt, now = Date.now()) {
  const ms = new Date(endsAt).getTime() - now;
  if (ms <= 0) return 'closing now';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins} min left`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m left` : `${h}h left`;
}

export async function broadcast(gameServerId, message) {
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message });
}

/**
 * Ends the running poll: removes it first (so a second closer sees nothing and stops),
 * broadcasts results, optionally posts to Discord and pays voters, then cleans up the votes.
 * Returns false when the poll was already gone.
 */
export async function closePoll(gameServerId, mod, active, reason) {
  const { moduleId, userConfig } = mod;
  const { variable, poll } = active;

  try {
    await takaro.variable.variableControllerDelete(variable.id);
  } catch (err) {
    console.log(`polls: poll ${poll.id} already closed by someone else (${err})`);
    return false;
  }

  const { counts, total, voterIds, votes } = await tally(gameServerId, moduleId, poll);
  const lines = formatResultLines(poll.options, counts, total);
  const winner = winnerText(poll.options, counts, total);
  const header = `Poll ${reason === 'manual' ? 'closed' : 'ended'}: ${poll.question}`;

  await broadcast(gameServerId, header);
  for (const line of lines) await broadcast(gameServerId, line);
  await broadcast(gameServerId, winner ? `${winner} (${total} vote${total === 1 ? '' : 's'})` : 'Nobody voted.');

  await setModuleVariable(gameServerId, moduleId, LAST_POLL_KEY, {
    id: poll.id,
    question: poll.question,
    options: poll.options,
    counts,
    total,
    closedAt: new Date().toISOString(),
  });

  if (userConfig.postResultsToDiscord) {
    const channel = String(userConfig.discordChannelId || '').trim();
    if (!channel) {
      console.log('polls: postResultsToDiscord is on but discordChannelId is empty, skipping Discord post');
    } else {
      try {
        const body = [`**Poll results: ${poll.question}**`, ...lines, winner ? `**${winner}** (${total} votes)` : 'Nobody voted.'].join('\n');
        await takaro.discord.discordControllerSendMessage(channel, { message: body });
      } catch (err) {
        console.log(`polls: Discord post failed: ${err}`);
      }
    }
  }

  const reward = Number(userConfig.voteReward) || 0;
  if (reward > 0 && voterIds.length > 0) {
    const currencyName = await getSetting('currencyName', gameServerId, 'coins');
    let paid = 0;
    for (const playerId of voterIds) {
      try {
        await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, { currency: reward });
        paid++;
      } catch (err) {
        console.log(`polls: could not pay vote reward to ${playerId}: ${err}`);
      }
    }
    if (paid > 0) await broadcast(gameServerId, `Thanks for voting! ${paid} voter${paid === 1 ? '' : 's'} got ${reward} ${currencyName}.`);
  }

  for (const v of votes) {
    try {
      await takaro.variable.variableControllerDelete(v.id);
    } catch (err) {
      console.log(`polls: could not delete vote ${v.id}: ${err}`);
    }
  }
  return true;
}
