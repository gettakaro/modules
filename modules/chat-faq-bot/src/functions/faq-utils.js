import { takaro } from '@takaro/helpers';

// Separate keys, so a server-wide row is never hidden behind many per-player rows in a search page.
const COOLDOWN_KEY_PREFIX = 'faq_cd:';
const PLAYER_COOLDOWN_KEY_PREFIX = 'faq_pcd:';

/** Lowercase, and turn every run of non-letter/non-digit characters into one space. */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}*]+/gu, ' ')
    .trim();
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word match of `term` inside an already normalized message.
 * A trailing `*` makes the last word a prefix match: `wip*` matches "wipe" and "wiped".
 */
function containsTerm(normalizedMessage, term) {
  const wildcard = term.trim().endsWith('*');
  const normalizedTerm = normalize(term).replace(/\*/g, '').trim();
  if (!normalizedTerm) return false;
  const pattern = new RegExp(`(^| )${escapeRegex(normalizedTerm)}${wildcard ? '' : '( |$)'}`, 'u');
  return pattern.test(normalizedMessage);
}

/** Every word of the trigger appears somewhere in the message, in any order. */
function containsAllWords(normalizedMessage, trigger) {
  const words = trigger
    .trim()
    .split(/\s+/)
    .filter((w) => normalize(w).replace(/\*/g, '').length > 0);
  if (words.length === 0) return false;
  return words.every((word) => containsTerm(normalizedMessage, word));
}

/** Returns a RegExp, or null when the pattern is invalid. */
export function compileRegex(pattern) {
  try {
    return new RegExp(pattern, 'iu');
  } catch {
    try {
      return new RegExp(pattern, 'i');
    } catch {
      return null;
    }
  }
}

/**
 * Does this entry match the message?
 * - any:   one of the triggers appears as a whole word or phrase
 * - all:   one of the triggers has ALL its words somewhere in the message (any order)
 * - regex: one of the triggers is a regular expression that matches (case-insensitive)
 */
export function entryMatches(entry, message) {
  const triggers = (entry.triggers || []).filter((t) => typeof t === 'string' && t.trim().length > 0);
  if (triggers.length === 0) return false;

  const mode = entry.match || 'any';
  if (mode === 'regex') {
    return triggers.some((pattern) => {
      const re = compileRegex(pattern);
      return re ? re.test(message) : false;
    });
  }

  const normalizedMessage = normalize(message);
  if (!normalizedMessage) return false;
  if (mode === 'all') return triggers.some((t) => containsAllWords(normalizedMessage, t));
  return triggers.some((t) => containsTerm(normalizedMessage, t));
}

export function activeEntries(config) {
  return (config.entries || []).filter((e) => e && e.enabled !== false && e.topic);
}

/** First enabled entry (in config order) that matches the message, or undefined. */
export function findMatchingEntry(config, message) {
  return activeEntries(config).find((entry) => entryMatches(entry, message));
}

/** Entry whose topic name equals `topic`, else the first entry whose triggers match it. */
export function findEntryByTopic(config, topic) {
  const wanted = normalize(topic);
  const entries = activeEntries(config);
  return entries.find((e) => normalize(e.topic) === wanted) || entries.find((e) => entryMatches(e, topic));
}

export async function getSetting(gameServerId, key, fallback) {
  try {
    const res = await takaro.settings.settingsControllerGetOne(key, gameServerId);
    return res.data.data.value || fallback;
  } catch {
    return fallback;
  }
}

/** Replaces {player} {prefix} {currency} and every configured placeholder. Unknown ones stay as they are. */
export async function renderAnswer(text, { gameServerId, playerName, config }) {
  const values = { player: playerName || 'there' };
  for (const p of config.placeholders || []) {
    if (p && p.name) values[String(p.name).toLowerCase()] = String(p.value ?? '');
  }

  // Only fetch settings that are used, also inside configured placeholder values.
  const everything = [String(text ?? ''), ...Object.values(values)].join(' ');
  if (everything.includes('{prefix}')) values.prefix = await getSetting(gameServerId, 'commandPrefix', '/');
  if (everything.includes('{currency}')) values.currency = await getSetting(gameServerId, 'currencyName', 'coins');

  const fill = (s) =>
    s.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name) => {
      const v = values[name.toLowerCase()];
      return v === undefined ? whole : v;
    });
  // Two passes so a configured placeholder may itself contain {prefix} or {player}.
  return fill(fill(String(text ?? '')));
}

/** An answer may hold several lines; each line becomes its own chat message. */
export function splitLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function cooldownKey(prefix, entry) {
  return `${prefix}${normalize(entry.topic).slice(0, 80)}`;
}

async function findCooldown(gameServerId, moduleId, key, playerId) {
  const filters = { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] };
  if (playerId) filters.playerId = [playerId];
  const res = await takaro.variable.variableControllerSearch({ filters });
  const rows = res.data.data || [];
  // A server-wide cooldown row has no player.
  return rows.find((r) => (playerId ? r.playerId === playerId : !r.playerId));
}

/** Milliseconds left on a cooldown row, 0 when expired or absent. */
function remainingMs(row, nowMs) {
  if (!row) return 0;
  const until = Number(row.value);
  if (!Number.isFinite(until)) return 0;
  return Math.max(0, until - nowMs);
}

async function setCooldown(gameServerId, moduleId, key, playerId, existing, seconds, nowMs) {
  if (!seconds || seconds <= 0) return;
  const until = nowMs + seconds * 1000;
  const body = {
    key,
    value: String(until),
    gameServerId,
    moduleId,
    expiresAt: new Date(until).toISOString(),
  };
  if (playerId) body.playerId = playerId;
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, body);
  } else {
    await takaro.variable.variableControllerCreate(body);
  }
}

/**
 * Checks the server-wide and per-player cooldown of an entry.
 * Returns { onCooldown, commit } — call commit() after answering to start both cooldowns.
 */
export async function checkCooldowns({ gameServerId, moduleId, playerId, entry }) {
  const globalKey = cooldownKey(COOLDOWN_KEY_PREFIX, entry);
  const playerKey = cooldownKey(PLAYER_COOLDOWN_KEY_PREFIX, entry);
  const nowMs = Date.now();
  const globalSeconds = Number(entry.cooldownSeconds) || 0;
  const playerSeconds = Number(entry.playerCooldownSeconds) || 0;

  const globalRow = await findCooldown(gameServerId, moduleId, globalKey, undefined);
  const playerRow = playerId ? await findCooldown(gameServerId, moduleId, playerKey, playerId) : undefined;

  const onCooldown =
    (globalSeconds > 0 && remainingMs(globalRow, nowMs) > 0) ||
    (playerSeconds > 0 && remainingMs(playerRow, nowMs) > 0);

  async function commit() {
    await setCooldown(gameServerId, moduleId, globalKey, undefined, globalRow, globalSeconds, nowMs);
    if (playerId) await setCooldown(gameServerId, moduleId, playerKey, playerId, playerRow, playerSeconds, nowMs);
  }

  return { onCooldown, commit };
}

/** Sends lines as a PM to one player, or to everyone. PM falls back to public chat when allowed. */
export async function deliver({ gameServerId, pog, lines, reply, fallbackToPublic }) {
  const send = (message, recipient) =>
    takaro.gameserver.gameServerControllerSendMessage(
      gameServerId,
      recipient ? { message, opts: { recipient: { gameId: recipient } } } : { message },
    );

  if (reply === 'pm' && pog && pog.gameId) {
    try {
      for (const line of lines) await send(line, pog.gameId);
      return 'pm';
    } catch (err) {
      if (!fallbackToPublic) throw err;
      console.log(`chat-faq-bot: private message failed (${err && err.message}), sending publicly instead`);
    }
  }
  for (const line of lines) await send(line);
  return 'public';
}

/**
 * Everything the player typed after the command word, e.g. "how do i get money" from "@faqtest how do i get money".
 * Falls back to the parsed argument when the raw chat line is not available.
 */
export function restOfLine(chatMessage, prefix, parsedArg) {
  const raw = String(chatMessage?.msg ?? '').trim();
  if (raw.startsWith(prefix)) {
    const afterPrefix = raw.slice(prefix.length).trim();
    const space = afterPrefix.search(/\s/);
    if (space > 0) return afterPrefix.slice(space).trim();
  }
  return String(parsedArg ?? '').trim();
}
