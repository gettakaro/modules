import { takaro, checkPermission } from '@takaro/helpers';

export const KEYS = {
  replyTo: 'pm_reply_to',
  ignore: 'pm_ignore',
  cooldown: 'pm_last_sent',
  mailbox: 'pm_mailbox',
  spy: 'pm_spy',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_IGNORED = 50;

export function renderTemplate(template, values) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

export async function getPrefix(gameServerId) {
  try {
    const res = await takaro.settings.settingsControllerGetOne('commandPrefix', gameServerId);
    return res.data.data.value || '/';
  } catch {
    return '/';
  }
}

/**
 * Takaro hands a `string` argument only its first word, so the full text is read from the raw chat
 * line with Takaro's own tokenizer: everything after the first `skip` tokens (command, player name).
 */
export function parseText(rawMessage, skip, fallback, maxLength) {
  const tokens = typeof rawMessage === 'string' ? rawMessage.match(/(?:[^\s"]+|"[^"]*")+/g) : null;
  const fromChat = tokens && tokens.length > skip ? tokens.slice(skip).join(' ').replace(/"/g, '').trim() : '';
  const text = (fromChat || String(fallback ?? '').trim()).replace(/\s+/g, ' ');
  return text.slice(0, Math.max(1, Number(maxLength) || 200));
}

// ---- per-player variables -------------------------------------------------------------------

async function findVar(gameServerId, moduleId, playerId, key) {
  const res = await takaro.variable.variableControllerSearch({
    filters: { key: [key], gameServerId: [gameServerId], moduleId: [moduleId], playerId: [playerId] },
  });
  return res.data.data[0] ?? null;
}

export async function readVar(gameServerId, moduleId, playerId, key, fallback) {
  const row = await findVar(gameServerId, moduleId, playerId, key);
  if (!row) return { id: null, value: fallback };
  try {
    return { id: row.id, value: JSON.parse(row.value) };
  } catch {
    console.error(`private-messages: could not parse ${key} of player ${playerId}, starting fresh`);
    return { id: row.id, value: fallback };
  }
}

export async function writeVar(gameServerId, moduleId, playerId, key, id, value) {
  const json = JSON.stringify(value);
  if (id) {
    await takaro.variable.variableControllerUpdate(id, { value: json });
    return id;
  }
  const res = await takaro.variable.variableControllerCreate({ key, value: json, gameServerId, moduleId, playerId });
  return res.data.data.id;
}

export async function deleteVar(id) {
  if (id) await takaro.variable.variableControllerDelete(id);
}

// ---- sending ------------------------------------------------------------------------------

export async function sendTo(gameServerId, gameId, message) {
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message,
    opts: { recipient: { gameId } },
  });
}

/**
 * Anti-spam: one private message or mail per `cooldownSeconds` per sender, shared by msg, r and mail.
 * Throws a user-facing message string when the sender has to wait.
 */
export async function checkCooldown(gameServerId, moduleId, playerId, cooldownSeconds, now) {
  const seconds = Number(cooldownSeconds) || 0;
  if (seconds <= 0) return null;
  const { id, value } = await readVar(gameServerId, moduleId, playerId, KEYS.cooldown, 0);
  const waitMs = Number(value) + seconds * 1000 - now;
  if (waitMs > 0) return { wait: Math.ceil(waitMs / 1000) };
  return { id };
}

export async function stampCooldown(gameServerId, moduleId, playerId, cooldown, now) {
  if (!cooldown) return;
  await writeVar(gameServerId, moduleId, playerId, KEYS.cooldown, cooldown.id, now);
}

// ---- ignore list --------------------------------------------------------------------------

export async function loadIgnore(gameServerId, moduleId, playerId) {
  const { id, value } = await readVar(gameServerId, moduleId, playerId, KEYS.ignore, []);
  return { id, list: Array.isArray(value) ? value : [] };
}

export function addIgnore(list, entry) {
  if (list.some((e) => e.playerId === entry.playerId)) return { list, added: false };
  if (list.length >= MAX_IGNORED) return { list, added: false, full: true };
  return { list: [...list, entry], added: true };
}

/** True when `receiverId` ignores `senderPog`'s player and the sender is not exempt (staff). */
export async function isIgnoredBy(gameServerId, moduleId, receiverId, senderPog) {
  if (checkPermission(senderPog, 'PM_IGNORE_EXEMPT')) return false;
  const { list } = await loadIgnore(gameServerId, moduleId, receiverId);
  return list.some((e) => e.playerId === senderPog.playerId);
}

// ---- mailbox ------------------------------------------------------------------------------

export function pruneMail(mails, expiryDays, now) {
  const days = Number(expiryDays) || 0;
  if (days <= 0) return mails;
  return mails.filter((m) => new Date(m.sentAt).getTime() + days * DAY_MS > now);
}

export async function loadMailbox(gameServerId, moduleId, playerId, expiryDays, now) {
  const { id, value } = await readVar(gameServerId, moduleId, playerId, KEYS.mailbox, []);
  const all = Array.isArray(value) ? value : [];
  const mails = pruneMail(all, expiryDays, now);
  return { id, mails, pruned: all.length - mails.length };
}

/**
 * Adds a mail. When the box is full the oldest READ mail makes room; a box full of unread mail
 * refuses new mail so nothing unread is lost.
 */
export function pushMail(mails, mail, size) {
  const max = Math.max(1, Number(size) || 10);
  const next = [...mails];
  while (next.length >= max) {
    const readIdx = next.findIndex((m) => m.read);
    if (readIdx === -1) return { mails, ok: false };
    next.splice(readIdx, 1);
  }
  next.push(mail);
  return { mails: next, ok: true };
}

export function formatAgo(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

export function formatMail(mail, now) {
  return `${mail.fromName} (${formatAgo(now - new Date(mail.sentAt).getTime())}): ${mail.text}`;
}

// ---- social spy ---------------------------------------------------------------------------

/**
 * Sends a copy of a private message to online staff who turned socialspy on and still hold PM_SPY.
 * Never throws: spying is best effort and must not block the message itself.
 */
export async function spyCopy(gameServerId, moduleId, cfg, excludeIds, line) {
  if (!cfg.socialSpy) return;
  try {
    const vars = await takaro.variable.variableControllerSearch({
      filters: { key: [KEYS.spy], gameServerId: [gameServerId], moduleId: [moduleId] },
      limit: 100,
    });
    const ids = vars.data.data.map((v) => v.playerId).filter((id) => id && !excludeIds.includes(id));
    if (!ids.length) return;
    const pogs = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], playerId: ids, online: [true] },
      limit: 100,
    });
    for (const pog of pogs.data.data) {
      if (!checkPermission(pog, 'PM_SPY')) continue;
      await sendTo(gameServerId, pog.gameId, renderTemplate(cfg.spyFormat, { message: line }));
    }
  } catch (err) {
    console.error(`private-messages: socialspy copy failed: ${err}`);
  }
}

// ---- name lookup --------------------------------------------------------------------------

/**
 * Finds one player on this game server by (partial) name, like Takaro's own `player` argument.
 * An exact, case-insensitive name match wins when the search returns several players.
 */
export async function resolvePlayerByName(gameServerId, input) {
  const search = await takaro.player.playerControllerSearch({ search: { name: [input] }, limit: 50 });
  const candidates = search.data.data;
  if (!candidates.length) return { error: `No player found with the name "${input}".` };

  const pogs = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: { gameServerId: [gameServerId], playerId: candidates.map((p) => p.id) },
    limit: 50,
  });
  const onServer = new Set(pogs.data.data.map((p) => p.playerId));
  const here = candidates.filter((p) => onServer.has(p.id));
  if (!here.length) return { error: `No player found with the name "${input}" on this server.` };

  const exact = here.filter((p) => String(p.name).toLowerCase() === input.toLowerCase());
  if (exact.length === 1) return { playerId: exact[0].id, name: exact[0].name };
  if (here.length === 1) return { playerId: here[0].id, name: here[0].name };
  return { error: `Several players match "${input}". Please type more of the name.` };
}

/**
 * The shared delivery path for msg and r: checks the target is online and not ignoring the sender,
 * applies the cooldown, delivers both sides, records the reply target and copies to socialspy.
 * Returns a user-facing error string, or null on success.
 */
export async function deliverPrivate({ gameServerId, moduleId, cfg, senderPog, senderName, target, text, prefix, now }) {
  if (target.playerId === senderPog.playerId) return 'You cannot message yourself.';

  const targetPog = await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, target.playerId);
  const tPog = targetPog.data.data;
  if (!tPog.online) {
    return `${target.name} is offline. Use ${prefix}mail ${target.name} <text> to leave a message.`;
  }
  if (await isIgnoredBy(gameServerId, moduleId, target.playerId, senderPog)) {
    return `${target.name} is not accepting your messages.`;
  }

  const cooldown = await checkCooldown(gameServerId, moduleId, senderPog.playerId, cfg.cooldownSeconds, now);
  if (cooldown && cooldown.wait) return `Slow down: wait ${cooldown.wait}s before sending another message.`;

  const values = { sender: senderName, receiver: target.name, message: text, prefix };
  await sendTo(gameServerId, tPog.gameId, renderTemplate(cfg.incomingFormat, values));
  await sendTo(gameServerId, senderPog.gameId, renderTemplate(cfg.outgoingFormat, values));

  const reply = await readVar(gameServerId, moduleId, target.playerId, KEYS.replyTo, null);
  await writeVar(gameServerId, moduleId, target.playerId, KEYS.replyTo, reply.id, {
    playerId: senderPog.playerId,
    name: senderName,
  });
  await stampCooldown(gameServerId, moduleId, senderPog.playerId, cooldown, now);
  await spyCopy(gameServerId, moduleId, cfg, [senderPog.playerId, target.playerId], `${senderName} -> ${target.name}: ${text}`);
  return null;
}

export async function getPlayerName(playerId, fallback = 'Unknown player') {
  try {
    const res = await takaro.player.playerControllerGetOne(playerId);
    return res.data.data.name || fallback;
  } catch {
    return fallback;
  }
}
