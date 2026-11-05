import { takaro, checkPermission } from '@takaro/helpers';

export const PERM = {
  alerts: 'NEW_PLAYER_CHECK_ALERTS',
  manage: 'NEW_PLAYER_CHECK_MANAGE',
  exempt: 'NEW_PLAYER_CHECK_EXEMPT',
};

export const KEYS = {
  status: 'npcheck:status',
  pending: 'npcheck:pending',
};

// A player-connected hook runs a few seconds after the join, so a POG younger than this is a first join.
const FIRST_JOIN_GRACE_MS = 15 * 60 * 1000;
// How long the cron job keeps retrying a player whose inventory was not known yet.
export const PENDING_MS = 60 * 60 * 1000;

/** True while the player is inside the first-join window or the configured watch window. */
export function isWatched(pog, cfg, nowMs) {
  const created = new Date(pog.createdAt).getTime();
  if (!Number.isFinite(created)) return false;
  const windowMs = Math.max(FIRST_JOIN_GRACE_MS, (Number(cfg.watchHours) || 0) * 3600000);
  return nowMs - created <= windowMs;
}

export function isExempt(pog) {
  return Boolean(checkPermission(pog, PERM.exempt));
}

/** The character level the game reports, or null when it reports none. */
export async function readLevel(gameServerId, pog, cfg) {
  const tracks = pog.progression && Array.isArray(pog.progression.tracks) ? pog.progression.tracks : [];
  const levels = tracks.filter((t) => typeof t.level === 'number');
  if (levels.length) {
    if (cfg.levelTrackKey) {
      const track = levels.find((t) => t.key === cfg.levelTrackKey);
      if (track) return { level: track.level, source: `progression ${track.key}` };
    } else {
      return { level: Math.max(...levels.map((t) => t.level)), source: 'progression' };
    }
  }

  if (cfg.levelCommand) {
    try {
      const command = cfg.levelCommand.split('{gameId}').join(pog.gameId);
      const res = await takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, { command });
      const raw = (res.data.data && res.data.data.rawResult) || '';
      const match = new RegExp(cfg.levelPattern || 'level (\\d+)', 'i').exec(raw);
      if (match && match[1] !== undefined && Number.isFinite(Number(match[1]))) {
        return { level: Number(match[1]), source: 'console command' };
      }
      console.log(`npcheck: level command gave no level: ${raw.slice(0, 200)}`);
    } catch (err) {
      console.log(`npcheck: level command failed: ${err}`);
    }
  }
  return { level: null, source: null };
}

/** The player's current inventory from Takaro's tracking history. known=false when there is no snapshot yet. */
export async function readInventory(gameServerId, playerId) {
  const tracking = takaro.tracking;
  try {
    if (typeof tracking.trackingControllerGetInventoryAt === 'function') {
      // A couple of seconds back: the API refuses a moment in the future, and clocks drift.
      const at = new Date(Date.now() - 2000).toISOString();
      const res = await tracking.trackingControllerGetInventoryAt({ gameServerId, playerId, at });
      const inv = res.data.data;
      if (!inv || !inv.snapshotTime) return { known: false, items: [] };
      return { known: true, items: inv.items || [] };
    }
    if (typeof tracking.trackingControllerGetPlayerInventoryHistory === 'function') {
      // Older Takaro: inventory history rows. The newest row per item is its current amount.
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 24 * 3600000);
      const res = await tracking.trackingControllerGetPlayerInventoryHistory({
        gameServerId,
        playerId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      });
      const rows = res.data.data || [];
      if (!rows.length) return { known: false, items: [] };
      const latest = new Map();
      for (const row of rows) {
        const seen = latest.get(row.itemId);
        if (!seen || new Date(row.createdAt) > new Date(seen.createdAt)) latest.set(row.itemId, row);
      }
      const items = [...latest.values()]
        .filter((row) => Number(row.quantity) > 0)
        .map((row) => ({ itemId: row.itemId, code: row.itemCode, name: row.itemName, quantity: row.quantity }));
      return { known: true, items };
    }
    console.log('npcheck: this Takaro version has no inventory tracking for modules');
  } catch (err) {
    console.log(`npcheck: inventory not available: ${err}`);
  }
  return { known: false, items: [] };
}

function itemMatches(invItem, configured) {
  if (!configured) return false;
  if (invItem.itemId === configured) return true;
  return typeof invItem.code === 'string' && invItem.code.toLowerCase() === String(configured).toLowerCase();
}

function qty(invItem) {
  const n = Number(invItem.quantity);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Pure: which rules the level and inventory break. */
export function evaluate(cfg, level, inventory) {
  const findings = [];
  const maxLevel = Number(cfg.maxLevelOnFirstJoin) || 0;
  if (maxLevel > 0 && level !== null && level > maxLevel) {
    findings.push({ rule: 'level', text: `level ${level} (limit ${maxLevel})`, action: cfg.levelAction || 'alert' });
  }

  if (inventory.known) {
    for (const entry of cfg.forbiddenItems || []) {
      const matches = inventory.items.filter((i) => itemMatches(i, entry.item));
      const count = matches.reduce((sum, i) => sum + qty(i), 0);
      const max = Number(entry.maxAmount) || 0;
      if (count === 0 || count <= max) continue;
      const name = matches[0].name || matches[0].code || entry.item;
      findings.push({
        rule: 'item',
        text: max === 0 ? `forbidden item ${name} x${count}` : `${name} x${count} (max ${max})`,
        action: cfg.itemAction || 'alert',
      });
    }

    const maxTotal = Number(cfg.maxTotalItems) || 0;
    const total = inventory.items.reduce((sum, i) => sum + qty(i), 0);
    if (maxTotal > 0 && total > maxTotal) {
      findings.push({
        rule: 'total',
        text: `${total} items in total (max ${maxTotal})`,
        action: cfg.totalItemsAction || 'alert',
      });
    }
  }
  return findings;
}

export function needsInventory(cfg) {
  return (cfg.forbiddenItems || []).length > 0 || (Number(cfg.maxTotalItems) || 0) > 0;
}

/** Reads everything and evaluates the rules for one player. */
export async function checkPlayer(gameServerId, playerId, cfg) {
  const pog = (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, playerId)).data.data;
  const { level, source } = await readLevel(gameServerId, pog, cfg);
  const inventory = needsInventory(cfg) ? await readInventory(gameServerId, playerId) : { known: false, items: [] };
  const findings = evaluate(cfg, level, inventory);
  return { pog, level, levelSource: source, inventory, findings };
}

/** One line for admins: what was found and what the module did. */
export function summarize(name, result, cfg) {
  const parts = [];
  if ((Number(cfg.maxLevelOnFirstJoin) || 0) > 0 || result.level !== null) {
    parts.push(result.level === null ? 'level not reported' : `level ${result.level}`);
  }
  if (needsInventory(cfg)) {
    parts.push(result.inventory.known ? `${result.inventory.items.length} item stacks` : 'inventory not known yet');
  }
  const verdict = result.findings.length ? `FLAGGED: ${result.findings.map((f) => f.text).join('; ')}` : 'no findings';
  return `[New player check] ${name}: ${parts.length ? parts.join(', ') + ' - ' : ''}${verdict}`;
}

// ---- variables ----

function scope(gameServerId, playerId, moduleId) {
  return { gameServerId: [gameServerId], playerId: [playerId], moduleId: [moduleId] };
}

export async function getVar(key, gameServerId, playerId, moduleId) {
  const res = await takaro.variable.variableControllerSearch({
    filters: { key: [key], ...scope(gameServerId, playerId, moduleId) },
  });
  return res.data.data[0] || null;
}

export async function getStatus(gameServerId, playerId, moduleId) {
  const row = await getVar(KEYS.status, gameServerId, playerId, moduleId);
  if (!row) return null;
  try {
    return { row, value: JSON.parse(row.value) };
  } catch {
    return { row, value: {} };
  }
}

export async function setVar(key, value, gameServerId, playerId, moduleId, expiresAt) {
  const existing = await getVar(key, gameServerId, playerId, moduleId);
  const body = { value: JSON.stringify(value), ...(expiresAt ? { expiresAt } : {}) };
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.id, body);
  } else {
    await takaro.variable.variableControllerCreate({ key, gameServerId, playerId, moduleId, ...body });
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
  // One at a time: the module runner allows only a few requests in flight.
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
      await takaro.discord.discordControllerSendMessage(discordChannelId, { message });
    } catch (err) {
      console.log(`npcheck: Discord alert failed: ${err}`);
    }
  }
  console.log(`npcheck: alerted ${sent} admin(s) in game${discordChannelId ? ' and Discord' : ''}`);
}

export async function findRole(name) {
  if (!name) return null;
  const res = await takaro.role.roleControllerSearch({ filters: { name: [name] } });
  return res.data.data.find((r) => r.name === name) || null;
}

/** Applies the strongest configured action. Returns a short description of what was done. */
export async function applyActions(gameServerId, playerId, findings, cfg) {
  const wanted = new Set(findings.map((f) => f.action));
  const done = [];
  if (wanted.has('role')) {
    const role = await findRole(cfg.flagRoleName);
    if (role) {
      await takaro.player.playerControllerAssignRole(playerId, role.id, { gameServerId });
      done.push(`role ${role.name}`);
    } else {
      done.push(`role "${cfg.flagRoleName}" not found`);
    }
  }
  const reason = cfg.actionReason || 'Your character did not pass the new player check.';
  if (wanted.has('ban')) {
    const duration = Number(cfg.banDuration) || 0;
    await takaro.player.banControllerCreate({
      gameServerId,
      playerId,
      reason,
      ...(duration > 0 ? { until: new Date(Date.now() + duration).toISOString() } : {}),
    });
    done.push(duration > 0 ? 'banned' : 'banned permanently');
  } else if (wanted.has('kick')) {
    await takaro.gameserver.gameServerControllerKickPlayer(gameServerId, playerId, { reason });
    done.push('kicked');
  }
  return done;
}

/**
 * Automatic flow (hook and cron job): records the result, alerts admins once per distinct set of
 * findings and applies the configured actions.
 */
export async function handleResult({ gameServerId, moduleId, cfg, playerId, name, result }) {
  const status = await getStatus(gameServerId, playerId, moduleId);
  if (!result.findings.length) {
    if (!status)
      await setVar(KEYS.status, { status: 'clean', at: new Date().toISOString() }, gameServerId, playerId, moduleId);
    console.log(summarize(name, result, cfg));
    return;
  }

  const fingerprint = result.findings.map((f) => f.text).join('|');
  const done = await applyActions(gameServerId, playerId, result.findings, cfg);
  const repeat = status && status.value.status === 'flagged' && status.value.fingerprint === fingerprint;
  const message = `${summarize(name, result, cfg)}. Action: ${done.length ? done.join(', ') : 'alert only'}.`;
  console.log(message);
  if (repeat) {
    console.log('npcheck: same findings as the last alert; admins not alerted again');
  } else {
    await alertAdmins(gameServerId, message, cfg.discordChannelId, playerId);
  }
  await setVar(
    KEYS.status,
    { status: 'flagged', fingerprint, findings: result.findings.map((f) => f.text), at: new Date().toISOString() },
    gameServerId,
    playerId,
    moduleId,
  );
}
