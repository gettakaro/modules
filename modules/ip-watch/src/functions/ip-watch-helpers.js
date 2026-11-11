import { takaro, checkPermission, axios } from '@takaro/helpers';

export const PERM_ALERTS = 'IP_WATCH_ALERTS';
export const PERM_MANAGE = 'IP_WATCH_MANAGE';
export const PERM_EXEMPT = 'IP_WATCH_EXEMPT';

const IP_INDEX_PREFIX = 'ipw_ip:';
const LAST_COUNTRY_KEY = 'ipw_last_country';
const MAX_INDEX_ENTRIES = 25;
// Takaro sometimes sends the same new-IP event 2-3 times for one connection.
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const DEFAULT_VPN_URLS = {
  proxycheck: 'https://proxycheck.io/v2/{ip}?vpn=1&risk=1&key={key}',
  ipapi: 'http://ip-api.com/json/{ip}?fields=status,message,proxy,hosting',
};

const ACTION_RANK = { alert: 0, kick: 1, ban: 2 };

// ── IP formatting ─────────────────────────────────────────────────────────────

/** Masks an IP so alerts never leak a full address unless showFullIp is on. */
export function maskIp(ip, showFullIp) {
  if (!ip) return 'unknown';
  if (showFullIp) return ip;
  if (ip.includes(':')) {
    const parts = ip.split(':').filter((p) => p.length > 0);
    return `${parts.slice(0, 2).join(':')}:x:x`;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return 'masked';
  return `${parts[0]}.${parts[1]}.x.x`;
}

/** Loopback, private and link-local addresses: many players share them on LAN or dev servers. */
export function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip.toLowerCase().startsWith('fe80:') || ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd')) {
    return true;
  }
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

// ── Identity conflicts ────────────────────────────────────────────────────────

const PLACEHOLDER_IDS = ['0', 'unknown', 'n/a', 'null', 'undefined', 'none'];

/** Junk platform ids games send for "no id", e.g. "<unknown/none>", "Unknown", "0". */
export function isPlaceholderId(value) {
  if (typeof value !== 'string') return true;
  const v = value.trim().toLowerCase();
  if (v.length === 0 || PLACEHOLDER_IDS.includes(v)) return true;
  return v.startsWith('<') && v.endsWith('>');
}

/**
 * Matched players that share a real id with the connection. Takaro can match a player on a
 * placeholder id (seen on prod: epicOnlineServicesId "<unknown/none>"); such a match is noise.
 */
export function realMatches(eventData) {
  const matched = Array.isArray(eventData && eventData.matchedPlayers) ? eventData.matchedPlayers : [];
  return matched.filter(
    (m) => m && m.playerId && Array.isArray(m.matchedOn) && m.matchedOn.some((col) => !isPlaceholderId(eventData[col])),
  );
}

// ── Exemption ─────────────────────────────────────────────────────────────────

export function isWhitelisted(player, whitelist) {
  if (!player || !Array.isArray(whitelist) || whitelist.length === 0) return false;
  const wanted = whitelist.map((w) => String(w).trim().toLowerCase()).filter((w) => w.length > 0);
  const ids = [player.id, player.name, player.steamId, player.epicOnlineServicesId, player.xboxLiveId, player.platformId]
    .filter((v) => typeof v === 'string' && v.length > 0)
    .map((v) => v.toLowerCase());
  return ids.some((id) => wanted.includes(id));
}

export function isExempt(player, pog, config) {
  if (isWhitelisted(player, config.whitelist)) return true;
  if (pog && checkPermission(pog, PERM_EXEMPT)) return true;
  return false;
}

// ── Variables (module-scoped, domain-wide) ────────────────────────────────────

async function findVariable(moduleId, key, playerId) {
  const filters = { key: [key], moduleId: [moduleId] };
  if (playerId) filters.playerId = [playerId];
  const res = await takaro.variable.variableControllerSearch({ filters });
  const rows = res.data.data.filter((row) => (playerId ? row.playerId === playerId : !row.playerId) && !row.gameServerId);
  return rows.length > 0 ? rows[0] : null;
}

async function writeVariable(moduleId, key, value, playerId) {
  const existing = await findVariable(moduleId, key, playerId);
  const serialized = JSON.stringify(value);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, { value: serialized });
    return;
  }
  const input = { key, value: serialized, moduleId };
  if (playerId) input.playerId = playerId;
  await takaro.variable.variableControllerCreate(input);
}

function parseJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Players this module has seen on an IP: [{ id, name }]. */
export async function readIpIndex(moduleId, ip) {
  const row = await findVariable(moduleId, `${IP_INDEX_PREFIX}${ip}`);
  if (!row) return [];
  const list = parseJson(row.value, []);
  return Array.isArray(list) ? list : [];
}

export async function addToIpIndex(moduleId, ip, player) {
  const list = await readIpIndex(moduleId, ip);
  const rest = list.filter((entry) => entry.id !== player.id);
  const next = [{ id: player.id, name: player.name, at: Date.now() }, ...rest].slice(0, MAX_INDEX_ENTRIES);
  await writeVariable(moduleId, `${IP_INDEX_PREFIX}${ip}`, next);
}

/** True when this player was already recorded on this IP moments ago: a repeated event, not a new connection. */
export async function isRepeatEvent(moduleId, ip, playerId, nowMs) {
  const own = (await readIpIndex(moduleId, ip)).find((entry) => entry && entry.id === playerId);
  return Boolean(own && Number(own.at) && nowMs - Number(own.at) < DUPLICATE_WINDOW_MS);
}

export async function readLastCountry(moduleId, playerId) {
  const row = await findVariable(moduleId, LAST_COUNTRY_KEY, playerId);
  if (!row) return null;
  const value = parseJson(row.value, null);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function writeLastCountry(moduleId, playerId, country) {
  await writeVariable(moduleId, LAST_COUNTRY_KEY, country, playerId);
}

// ── Shared IP lookup ──────────────────────────────────────────────────────────

/**
 * Other players on this domain that used `ip`: the module's own index plus every
 * player-on-gameserver whose last known IP is exactly `ip`. Returns [{ id, name }].
 */
export async function findPlayersOnIp(moduleId, ip, excludePlayerId) {
  const found = new Map();
  for (const entry of await readIpIndex(moduleId, ip)) {
    if (entry && entry.id && entry.id !== excludePlayerId) found.set(entry.id, entry.name || entry.id);
  }

  try {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      search: { ip: [ip] },
      extend: ['player'],
      limit: 50,
    });
    for (const pog of res.data.data) {
      // `search` is a partial match: 1.2.3.4 also finds 1.2.3.45.
      if (pog.ip !== ip || pog.playerId === excludePlayerId) continue;
      if (!found.has(pog.playerId)) found.set(pog.playerId, (pog.player && pog.player.name) || pog.playerId);
    }
  } catch (err) {
    console.log(`ip-watch: player search by IP failed: ${err.message}`);
  }

  return [...found.entries()].map(([id, name]) => ({ id, name }));
}

// ── Country ───────────────────────────────────────────────────────────────────

/** Latest country in the player's IP history from an IP other than `currentIp`. */
export function previousCountryFromHistory(ipHistory, currentIp) {
  if (!Array.isArray(ipHistory)) return null;
  const sorted = [...ipHistory].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const prev = sorted.find((entry) => entry.ip !== currentIp && entry.country);
  return prev ? prev.country : null;
}

export function lastCountryFromHistory(ipHistory) {
  if (!Array.isArray(ipHistory)) return null;
  const sorted = [...ipHistory].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const last = sorted.find((entry) => entry.country);
  return last ? last.country : null;
}

/** Distinct IPs in history, newest first. */
export function distinctIps(ipHistory) {
  if (!Array.isArray(ipHistory)) return [];
  const sorted = [...ipHistory].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const seen = [];
  for (const entry of sorted) {
    if (entry.ip && !seen.includes(entry.ip)) seen.push(entry.ip);
  }
  return seen;
}

// ── VPN lookup ────────────────────────────────────────────────────────────────

export function buildVpnUrl(config, ip) {
  const template = config.vpnApiUrl && config.vpnApiUrl.trim().length > 0 ? config.vpnApiUrl.trim() : DEFAULT_VPN_URLS[config.vpnProvider];
  return template.split('{ip}').join(encodeURIComponent(ip)).split('{key}').join(encodeURIComponent(config.vpnApiKey || ''));
}

/** Reads a provider response. Returns { flagged, detail } or null when the answer is unusable. */
export function parseVpnResponse(provider, body, ip) {
  if (!body || typeof body !== 'object') return null;
  if (provider === 'ipapi') {
    if (body.status && body.status !== 'success') return null;
    const flags = [];
    if (body.proxy === true) flags.push('proxy');
    if (body.hosting === true) flags.push('hosting');
    return { flagged: flags.length > 0, detail: flags.join(', ') };
  }
  const entry = body[ip];
  if (!entry || typeof entry !== 'object') return null;
  const flagged = entry.proxy === 'yes';
  const parts = [];
  if (entry.type) parts.push(String(entry.type));
  if (entry.risk !== undefined) parts.push(`risk ${entry.risk}`);
  return { flagged, detail: parts.join(', ') };
}

/** Returns { flagged, detail } or null when the lookup failed or was skipped. */
export async function checkVpn(config, ip) {
  if (!config.vpnCheck) return null;
  if (isPrivateIp(ip)) return null;
  if (config.vpnProvider === 'proxycheck' && !config.vpnApiKey && !config.vpnApiUrl) {
    console.log('ip-watch: VPN check is on but no API key is set, skipping');
    return null;
  }
  try {
    const res = await axios.get(buildVpnUrl(config, ip), { timeout: 5000 });
    const parsed = parseVpnResponse(config.vpnProvider, res.data, ip);
    if (!parsed) console.log('ip-watch: VPN API gave an unusable answer, skipping');
    return parsed;
  } catch (err) {
    console.log(`ip-watch: VPN lookup failed, skipping: ${err.message}`);
    return null;
  }
}

// ── Alerts & actions ──────────────────────────────────────────────────────────

async function onlineAlertRecipients(gameServerId) {
  const recipients = [];
  let page = 0;
  while (page < 20) {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], online: [true] },
      page,
      limit: 100,
    });
    for (const pog of res.data.data) {
      if (checkPermission(pog, PERM_ALERTS)) recipients.push(pog);
    }
    const total = res.data.meta.total ?? res.data.data.length;
    if ((page + 1) * 100 >= total || res.data.data.length === 0) break;
    page++;
  }
  return recipients;
}

/** PMs every online IP_WATCH_ALERTS holder, then posts to Discord when configured. Sequential on purpose. */
export async function sendAlert(gameServerId, config, message) {
  const text = `[IP Watch] ${message}`;
  console.log(text);
  let delivered = 0;
  try {
    const recipients = await onlineAlertRecipients(gameServerId);
    for (const pog of recipients) {
      try {
        await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
          message: text,
          opts: { recipient: { gameId: pog.gameId } },
        });
        delivered++;
      } catch (err) {
        console.log(`ip-watch: PM to ${pog.gameId} failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.log(`ip-watch: could not list online admins: ${err.message}`);
  }

  const channel = (config.discordChannelId || '').trim();
  if (channel) {
    try {
      await takaro.discord.discordControllerSendMessage(channel, { message: text });
      delivered++;
    } catch (err) {
      console.log(`ip-watch: Discord alert failed: ${err.message}`);
    }
  }
  return delivered;
}

export function strongestAction(actions) {
  return actions.reduce((best, a) => ((ACTION_RANK[a] ?? 0) > (ACTION_RANK[best] ?? 0) ? a : best), 'alert');
}

export async function applyAction(gameServerId, playerId, config, action) {
  if (action === 'ban') {
    const until = new Date(Date.now() + Number(config.banDuration || 0));
    await takaro.player.banControllerCreate({ gameServerId, playerId, until, reason: config.kickBanReason });
    return 'banned';
  }
  if (action === 'kick') {
    await takaro.gameserver.gameServerControllerKickPlayer(gameServerId, playerId, { reason: config.kickBanReason });
    return 'kicked';
  }
  return null;
}

export function formatNames(players, max = 5) {
  const names = players.slice(0, max).map((p) => p.name);
  const more = players.length > max ? ` +${players.length - max} more` : '';
  return `${names.join(', ')}${more}`;
}
