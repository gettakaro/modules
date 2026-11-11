import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { KEYS, PERMS, getVariable } from './lucky-drop-helpers.js';

function ago(iso, nowMs) {
  const min = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 60000));
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function main() {
  const { gameServerId, module: mod, pog, player } = data;
  const moduleId = mod.moduleId;
  const config = mod.userConfig;
  const nowMs = Date.now();

  if (!checkPermission(pog, PERMS.admin)) {
    throw new TakaroUserError('You do not have permission to view lucky drop stats.');
  }

  const [history, nextAt, race] = await Promise.all([
    getVariable(gameServerId, moduleId, KEYS.history),
    getVariable(gameServerId, moduleId, KEYS.nextAt),
    getVariable(gameServerId, moduleId, KEYS.race),
  ]);

  const lines = [];
  let header = `Lucky drops (${config.mode}): ${history?.total || 0} total`;
  const byRarity = Object.entries(history?.byRarity || {});
  if (byRarity.length > 0) header += ` | ${byRarity.map(([r, n]) => `${r} ${n}`).join(', ')}`;
  lines.push(header);

  if (race && new Date(race.expiresAt).getTime() > nowMs) {
    lines.push(`Claim race running: ${race.tier.rarity} (${race.reward})`);
  } else if (nextAt) {
    const min = Math.round((new Date(nextAt).getTime() - nowMs) / 60000);
    lines.push(min > 0 ? `Next drop in about ${min} min` : 'Next drop is due (waiting for enough players)');
  } else {
    lines.push('Next drop: not scheduled yet (the timer starts at the next check)');
  }

  const recent = (history?.recent || []).slice(0, 5);
  if (recent.length === 0) {
    lines.push('No drops yet.');
  } else {
    for (const d of recent) {
      lines.push(`${ago(d.at, nowMs)}: ${d.player} - ${d.rarity}: ${d.reward}${d.failed ? ' (delivery failed)' : ''}`);
    }
  }

  for (const line of lines) {
    await player.pm(line);
  }
}

await main();
