import { takaro, checkPermission, axios } from '@takaro/helpers';

export const PERM = {
  alerts: 'STEAM_GUARD_ALERTS',
  manage: 'STEAM_GUARD_MANAGE',
  exempt: 'STEAM_GUARD_EXEMPT',
};

export const KEYS = {
  profile: 'spg:profile',
  status: 'spg:status',
  allowed: 'spg:allowed',
};

export const STEAM_API = 'https://api.steampowered.com';
const TIMEOUT_MS = 8000;
const DAY_MS = 24 * 3600 * 1000;

// Steam app IDs for the game types Takaro knows by name. Other games set appId in the config.
const APP_IDS = { SEVENDAYSTODIE: 251570, RUST: 252490 };

// ---- small helpers ----

function qs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function isSteamId(value) {
  return typeof value === 'string' && /^\d{17}$/.test(value);
}

/** The player's 64-bit Steam ID, or null for players without one (console, Epic, Minecraft...). */
export async function steamIdOf(player) {
  if (player && isSteamId(player.steamId)) return player.steamId;
  if (player && player.steamId === undefined && player.id) {
    const full = (await takaro.player.playerControllerGetOne(player.id)).data.data;
    if (isSteamId(full.steamId)) return full.steamId;
  }
  return null;
}

/** The Steam app ID the hours rule uses: the configured one, or a known one for the game type. */
export async function resolveAppId(gameServerId, cfg) {
  const configured = num(cfg.appId);
  if (configured && configured > 0) return configured;
  try {
    const server = (await takaro.gameserver.gameServerControllerGetOne(gameServerId)).data.data;
    return APP_IDS[server.type] || null;
  } catch (err) {
    console.log(`steam-guard: could not read the game type: ${err}`);
    return null;
  }
}

// ---- Steam Web API ----

async function steamGet(path, params) {
  const res = await axios.get(`${STEAM_API}${path}?${qs(params)}`, {
    timeout: TIMEOUT_MS,
  });
  return res.data;
}

function describeError(err) {
  const status = err && err.response && err.response.status;
  if (status === 401 || status === 403) return 'Steam refused the API key (check steamApiKey)';
  if (status === 429) return 'Steam rate limit hit, try again later';
  if (status) return `Steam answered HTTP ${status}`;
  const message = (err && err.message) || String(err);
  if (message.includes('not allowed from Modules')) {
    return 'This Takaro instance blocks api.steampowered.com for modules (egress allowlist); ask Takaro support to allow it';
  }
  return `Steam API not reachable (${message})`;
}

/**
 * Reads one profile from the Steam Web API. One request at a time: the module runner allows only a few in flight.
 * Throws when the summary or ban request fails; the optional parts (level, hours, family sharing) just stay unknown.
 */
export async function fetchFromSteam(steamId, cfg, appId, wants) {
  const key = cfg.steamApiKey;
  let summaryData;
  let bansData;
  try {
    summaryData = await steamGet('/ISteamUser/GetPlayerSummaries/v2/', {
      key,
      steamids: steamId,
    });
    bansData = await steamGet('/ISteamUser/GetPlayerBans/v1/', {
      key,
      steamids: steamId,
    });
  } catch (err) {
    throw new Error(describeError(err));
  }
  const summary = ((summaryData && summaryData.response && summaryData.response.players) || [])[0];
  const bans = ((bansData && bansData.players) || [])[0];
  if (!summary) throw new Error(`Steam knows no profile ${steamId}`);

  const profile = {
    steamId,
    source: 'steam',
    fetchedAt: new Date().toISOString(),
    // 3 = public. 1 (private) and 2 (friends only) both hide the profile from us.
    visibility: summary.communityvisibilitystate === 3 ? 'public' : 'private',
    accountCreated: summary.timecreated ? new Date(summary.timecreated * 1000).toISOString() : null,
    level: null,
    vacBans: bans ? num(bans.NumberOfVACBans) || 0 : null,
    gameBans: bans ? num(bans.NumberOfGameBans) || 0 : null,
    daysSinceLastBan: bans ? num(bans.DaysSinceLastBan) : null,
    communityBanned: bans ? Boolean(bans.CommunityBanned) : null,
    appId: appId || null,
    hours: null,
    familyLender: null,
  };

  if (wants.level) {
    try {
      const res = await steamGet('/IPlayerService/GetSteamLevel/v1/', {
        key,
        steamid: steamId,
      });
      profile.level = num(res && res.response && res.response.player_level);
    } catch (err) {
      console.log(`steam-guard: Steam level not available: ${describeError(err)}`);
    }
  }

  if (wants.hours && appId) {
    try {
      const res = await steamGet('/IPlayerService/GetOwnedGames/v1/', {
        key,
        steamid: steamId,
        include_played_free_games: 1,
        'appids_filter[0]': appId,
      });
      const body = (res && res.response) || {};
      // A private game list answers with an empty object; a visible list has game_count.
      if (body.game_count !== undefined) {
        const game = (body.games || []).find((g) => Number(g.appid) === Number(appId));
        profile.hours = game ? Math.floor((Number(game.playtime_forever) || 0) / 6) / 10 : 0;
      }
    } catch (err) {
      console.log(`steam-guard: game hours not available: ${describeError(err)}`);
    }
  }

  if (wants.family && appId) {
    try {
      const res = await steamGet('/IPlayerService/IsPlayingSharedGame/v1/', {
        key,
        steamid: steamId,
        appid_playing: appId,
      });
      const lender = res && res.response && res.response.lender_steamid;
      if (lender !== undefined) profile.familyLender = String(lender);
    } catch (err) {
      console.log(`steam-guard: family sharing not available: ${describeError(err)}`);
    }
  }
  return profile;
}

/** The Steam data Takaro itself stores on the player, used when no API key is set. Null when there is none. */
export async function fromTakaro(playerId, steamId) {
  const p = (await takaro.player.playerControllerGetOne(playerId)).data.data;
  const hasAny = p.steamAccountCreated || num(p.steamLevel) !== null || num(p.steamNumberOfVACBans) !== null;
  if (!hasAny) return null;
  return {
    steamId,
    source: 'takaro',
    fetchedAt: new Date().toISOString(),
    visibility: null,
    accountCreated: p.steamAccountCreated || null,
    level: num(p.steamLevel),
    vacBans: num(p.steamNumberOfVACBans),
    gameBans: null,
    daysSinceLastBan: num(p.steamsDaysSinceLastBan),
    communityBanned: p.steamCommunityBanned === undefined ? null : Boolean(p.steamCommunityBanned),
    appId: null,
    hours: null,
    familyLender: null,
  };
}

function wants(cfg) {
  return {
    level: (num(cfg.minSteamLevel) || 0) > 0,
    hours: (num(cfg.minGameHours) || 0) > 0,
    family: Boolean(cfg.flagFamilySharing),
  };
}

/**
 * The player's Steam profile: from the cache variable when it is fresh, else from Steam (or Takaro's own
 * Steam data when no API key is set). Returns { profile, cached, error }.
 */
export async function getProfile({ gameServerId, moduleId, playerId, steamId, cfg, useCache }) {
  if (useCache) {
    const row = await getVar(KEYS.profile, gameServerId, playerId, moduleId);
    if (row) {
      try {
        const cached = JSON.parse(row.value);
        if (cached.steamId === steamId) return { profile: cached, cached: true, error: null };
      } catch {
        // A broken cache row is simply refreshed.
      }
    }
  }

  let profile = null;
  let error = null;
  if (cfg.steamApiKey) {
    const appId = await resolveAppId(gameServerId, cfg);
    try {
      profile = await fetchFromSteam(steamId, cfg, appId, wants(cfg));
    } catch (err) {
      error = err.message || String(err);
      console.log(`steam-guard: ${error}; using the Steam data Takaro stores instead`);
      profile = await fromTakaro(playerId, steamId);
    }
  } else {
    profile = await fromTakaro(playerId, steamId);
    if (!profile) error = 'No steamApiKey set and Takaro has no Steam data for this player';
  }

  if (profile) {
    const hours = Math.max(1, num(cfg.cacheHours) || 24);
    await setVar(
      KEYS.profile,
      profile,
      gameServerId,
      playerId,
      moduleId,
      new Date(Date.now() + hours * 3600 * 1000).toISOString(),
    );
  }
  return { profile, cached: false, error };
}

// ---- rules ----

/** Pure: which rules the profile breaks. Unknown values (private profile, no API key) never break a rule. */
export function evaluate(cfg, profile, nowMs) {
  const findings = [];
  const minAge = num(cfg.minAccountAgeDays) || 0;
  if (minAge > 0 && profile.accountCreated) {
    const days = Math.floor((nowMs - new Date(profile.accountCreated).getTime()) / DAY_MS);
    if (days < minAge) {
      findings.push({
        rule: 'age',
        text: `account ${days} days old (min ${minAge})`,
        action: cfg.accountAgeAction,
      });
    }
  }

  if (cfg.flagPrivateProfile && profile.visibility === 'private') {
    findings.push({
      rule: 'private',
      text: 'private Steam profile',
      action: cfg.privateAction,
    });
  }

  const minLevel = num(cfg.minSteamLevel) || 0;
  if (minLevel > 0 && profile.level !== null && profile.level < minLevel) {
    findings.push({
      rule: 'level',
      text: `Steam level ${profile.level} (min ${minLevel})`,
      action: cfg.levelAction,
    });
  }

  const minHours = num(cfg.minGameHours) || 0;
  if (minHours > 0 && profile.hours !== null && profile.hours < minHours) {
    findings.push({
      rule: 'hours',
      text: `${profile.hours}h in this game (min ${minHours})`,
      action: cfg.hoursAction,
    });
  }

  if (cfg.checkBans) {
    const total = (profile.vacBans || 0) + (profile.gameBans || 0);
    const recent = num(cfg.banRecentDays) || 0;
    const days = profile.daysSinceLastBan;
    if (total > 0 && (recent === 0 || days === null || days < recent)) {
      const kinds = [];
      if (profile.vacBans) kinds.push(`${profile.vacBans} VAC`);
      if (profile.gameBans) kinds.push(`${profile.gameBans} game`);
      findings.push({
        rule: 'ban',
        text: `${kinds.join(' + ')} ban(s), last ${days === null ? '?' : days} days ago${recent ? ` (flag < ${recent})` : ''}`,
        action: cfg.banAction,
      });
    }
  }

  if (cfg.flagFamilySharing && profile.familyLender && profile.familyLender !== '0') {
    findings.push({
      rule: 'family',
      text: `game borrowed via family sharing from ${profile.familyLender}`,
      action: cfg.familyAction,
    });
  }

  for (const f of findings) if (!f.action) f.action = 'alert';
  return findings;
}

/** Short facts about the profile for admins, e.g. "public, 6y old, level 20, 0 bans". */
export function describe(profile, nowMs) {
  const parts = [];
  if (profile.visibility) parts.push(profile.visibility);
  if (profile.accountCreated) {
    const days = Math.floor((nowMs - new Date(profile.accountCreated).getTime()) / DAY_MS);
    parts.push(days >= 365 ? `${Math.floor(days / 365)}y old` : `${days}d old`);
  } else {
    parts.push('age hidden');
  }
  parts.push(profile.level === null ? 'level ?' : `level ${profile.level}`);
  if (profile.appId) parts.push(profile.hours === null ? 'hours hidden' : `${profile.hours}h played`);
  const bans = (profile.vacBans || 0) + (profile.gameBans || 0);
  parts.push(profile.vacBans === null ? 'bans ?' : `${bans} bans`);
  if (profile.familyLender && profile.familyLender !== '0') parts.push('family shared');
  if (profile.source === 'takaro') parts.push('Takaro data');
  return parts.join(', ');
}

// ---- exemptions ----

export async function exemptReason({ pog, steamId, cfg, gameServerId, playerId, moduleId }) {
  if (checkPermission(pog, PERM.exempt)) return 'has the exempt permission';
  if ((cfg.whitelist || []).map((s) => String(s).trim()).includes(steamId)) return 'is on the whitelist';
  const allowed = await getVar(KEYS.allowed, gameServerId, playerId, moduleId);
  if (allowed) return 'was allowed by an admin (sgallow)';
  return null;
}

// ---- variables ----

function scope(gameServerId, playerId, moduleId) {
  return {
    gameServerId: [gameServerId],
    playerId: [playerId],
    moduleId: [moduleId],
  };
}

export async function getVar(key, gameServerId, playerId, moduleId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: { key: [key], ...scope(gameServerId, playerId, moduleId) },
  });
  return res.data.data[0] || null;
}

export async function getJson(key, gameServerId, playerId, moduleId) {
  const row = await getVar(key, gameServerId, playerId, moduleId);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return {};
  }
}

export async function setVar(key, value, gameServerId, playerId, moduleId, expiresAt) {
  const existing = await getVar(key, gameServerId, playerId, moduleId);
  const body = {
    value: JSON.stringify(value),
    ...(expiresAt ? { expiresAt } : {}),
  };
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, body);
  } else {
    await takaro.variable.variableControllerCreate({
      key,
      gameServerId,
      playerId,
      moduleId,
      ...body,
    });
  }
}

export async function deleteVar(key, gameServerId, playerId, moduleId) {
  const existing = await getVar(key, gameServerId, playerId, moduleId);
  if (existing) await takaro.variable.variableControllerDelete(existing.id);
}

// ---- alerts and actions ----

export async function alertAdmins(gameServerId, message, discordChannelId, aboutPlayerId) {
  const online = (
    await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], online: [true] },
      limit: 100,
    })
  ).data.data;
  let sent = 0;
  for (const admin of online) {
    if (admin.playerId === aboutPlayerId || !checkPermission(admin, PERM.alerts)) continue;
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
      message,
      opts: { recipient: { gameId: admin.gameId } },
    });
    sent++;
  }
  if (discordChannelId) {
    try {
      await takaro.discord.discordControllerSendMessage(discordChannelId, {
        message,
      });
    } catch (err) {
      console.log(`steam-guard: Discord alert failed: ${err}`);
    }
  }
  console.log(`steam-guard: alerted ${sent} admin(s) in game${discordChannelId ? ' and Discord' : ''}`);
}

/** Applies the strongest configured action (ban beats kick). Returns a short description of what was done. */
export async function applyActions(gameServerId, playerId, findings, cfg) {
  const wanted = new Set(findings.map((f) => f.action));
  const reason = cfg.actionReason || 'Your Steam profile does not meet this server’s requirements.';
  if (wanted.has('ban')) {
    const duration = num(cfg.banDuration) || 0;
    await takaro.player.banControllerCreate({
      gameServerId,
      playerId,
      reason,
      ...(duration > 0 ? { until: new Date(Date.now() + duration).toISOString() } : {}),
    });
    return [duration > 0 ? 'banned' : 'banned permanently'];
  }
  if (wanted.has('kick')) {
    await takaro.gameserver.gameServerControllerKickPlayer(gameServerId, playerId, { reason });
    return ['kicked'];
  }
  return [];
}

/** Hook flow: records the result, alerts admins once per distinct set of findings and applies the actions. */
export async function handleResult({ gameServerId, moduleId, cfg, playerId, name, steamId, profile }) {
  const nowMs = Date.now();
  const findings = evaluate(cfg, profile, nowMs);
  const status = await getJson(KEYS.status, gameServerId, playerId, moduleId);
  const head = `[Steam guard] ${name} (${steamId})`;

  if (!findings.length) {
    await setVar(KEYS.status, { status: 'clean', at: new Date(nowMs).toISOString() }, gameServerId, playerId, moduleId);
    console.log(`${head}: ${describe(profile, nowMs)} - no findings`);
    return { findings, done: [] };
  }

  const fingerprint = findings
    .map((f) => f.rule)
    .sort()
    .join('|');
  const done = await applyActions(gameServerId, playerId, findings, cfg);
  const message = `${head}: FLAGGED: ${findings.map((f) => f.text).join('; ')}. Action: ${
    done.length ? done.join(', ') : 'alert only'
  }.`;
  console.log(message);
  const repeat = status && status.status === 'flagged' && status.fingerprint === fingerprint;
  if (repeat && !done.length) {
    console.log('steam-guard: same findings as the last alert; admins not alerted again');
  } else {
    await alertAdmins(gameServerId, message, cfg.discordChannelId, playerId);
  }
  await setVar(
    KEYS.status,
    {
      status: 'flagged',
      fingerprint,
      findings: findings.map((f) => f.text),
      at: new Date(nowMs).toISOString(),
    },
    gameServerId,
    playerId,
    moduleId,
  );
  return { findings, done };
}

/** Checks that the Steam Web API is reachable from Takaro and, when set, that the API key works. */
export async function testSteam(cfg, steamId) {
  const lines = [];
  try {
    const res = await axios.get(`${STEAM_API}/ISteamWebAPIUtil/GetServerInfo/v1/`, { timeout: TIMEOUT_MS });
    lines.push(
      `Steam API reachable (server time ${res.data && res.data.servertimestring ? res.data.servertimestring : 'ok'}).`,
    );
  } catch (err) {
    lines.push(`${describeError(err)}. Until then only the Steam data Takaro stores is used.`);
    return { ok: false, lines };
  }
  if (!cfg.steamApiKey) {
    lines.push(
      'No steamApiKey set: only the Steam data Takaro stores itself is used (no private-profile, hours or family-sharing checks).',
    );
    return { ok: true, lines };
  }
  try {
    const res = await axios.get(
      `${STEAM_API}/ISteamUser/GetPlayerBans/v1/?${qs({ key: cfg.steamApiKey, steamids: steamId || '76561197960287930' })}`,
      { timeout: TIMEOUT_MS },
    );
    const ok = Array.isArray(res.data && res.data.players);
    lines.push(ok ? 'API key works.' : 'API key answered, but with an unexpected reply.');
    return { ok, lines };
  } catch (err) {
    lines.push(`${describeError(err)}.`);
    return { ok: false, lines };
  }
}
