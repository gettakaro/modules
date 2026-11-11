import { takaro, data, checkPermission, TakaroUserError } from '@takaro/helpers';
import {
  PERM_MANAGE,
  distinctIps,
  lastCountryFromHistory,
  findPlayersOnIp,
  isPrivateIp,
  maskIp,
  formatNames,
} from './ip-watch-helpers.js';

const MAX_IPS_CHECKED = 10;

async function main() {
  const { pog, player, arguments: args, module: mod } = data;
  const config = mod.userConfig;

  if (!checkPermission(pog, PERM_MANAGE)) {
    throw new TakaroUserError('You do not have permission to use ipcheck.');
  }

  const target = args.player;
  if (!target || !target.playerId) {
    throw new TakaroUserError('Usage: ipcheck <player>');
  }

  const res = await takaro.player.playerControllerGetOne(target.playerId);
  const targetPlayer = res.data.data;
  const ips = distinctIps(targetPlayer.ipHistory);
  const lastCountry = lastCountryFromHistory(targetPlayer.ipHistory) || 'unknown';

  // Sequential on purpose: the module sandbox caps concurrent outbound requests.
  const shared = new Map();
  const sharedIps = [];
  for (const ip of ips.slice(0, MAX_IPS_CHECKED)) {
    if (isPrivateIp(ip)) continue;
    const others = await findPlayersOnIp(mod.moduleId, ip, targetPlayer.id);
    if (others.length > 0) sharedIps.push(maskIp(ip, config.showFullIp));
    for (const other of others) shared.set(other.id, other);
  }

  const lines = [
    `[IP Watch] ${targetPlayer.name}: ${ips.length} known IP${ips.length === 1 ? '' : 's'}, last country ${lastCountry}.`,
  ];
  if (ips.length > 0) {
    lines.push(`Latest IP: ${maskIp(ips[0], config.showFullIp)}`);
  }
  if (shared.size > 0) {
    lines.push(`Shares IP with: ${formatNames([...shared.values()], 10)} (via ${sharedIps.join(', ')})`);
  } else {
    lines.push('Shares IP with: nobody');
  }
  if (ips.length > MAX_IPS_CHECKED) {
    lines.push(`(Only the newest ${MAX_IPS_CHECKED} IPs were checked for sharing.)`);
  }

  for (const line of lines) {
    await player.pm(line);
  }
}

await main();
