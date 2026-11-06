import { takaro, data } from '@takaro/helpers';
import {
  isExempt,
  isPrivateIp,
  maskIp,
  findPlayersOnIp,
  addToIpIndex,
  readLastCountry,
  isRepeatEvent,
  writeLastCountry,
  previousCountryFromHistory,
  checkVpn,
  sendAlert,
  strongestAction,
  applyAction,
  formatNames,
} from './ip-watch-helpers.js';

async function main() {
  const { gameServerId, player, pog, eventData, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;
  const ip = eventData && eventData.ip;
  const country = (eventData && eventData.country) || null;

  if (!player || !ip) {
    console.log('ip-watch: event has no player or IP, nothing to check');
    return;
  }

  if (isExempt(player, pog, config)) {
    console.log(`ip-watch: ${player.name} is exempt, skipping`);
    return;
  }

  if (!isPrivateIp(ip) && (await isRepeatEvent(moduleId, ip, player.id, Date.now()))) {
    console.log(`ip-watch: repeated new-IP event for ${player.name}, already checked, skipping`);
    return;
  }

  const findings = [];
  const actions = [];
  const shownIp = maskIp(ip, config.showFullIp);

  // (a) Shared IP
  if (config.sharedIpCheck) {
    if (isPrivateIp(ip)) {
      console.log('ip-watch: private/loopback IP, skipping shared IP check');
    } else {
      const others = await findPlayersOnIp(moduleId, ip, player.id);
      if (others.length > 0) {
        findings.push(`shares IP ${shownIp} with ${formatNames(others)}`);
        actions.push(config.sharedIpAction);
      }
    }
  }

  // (c) Country change
  if (config.countryChangeCheck && country) {
    let previous = await readLastCountry(moduleId, player.id);
    if (!previous) {
      try {
        const full = await takaro.player.playerControllerGetOne(player.id);
        previous = previousCountryFromHistory(full.data.data.ipHistory, ip);
      } catch (err) {
        console.log(`ip-watch: could not read IP history: ${err.message}`);
      }
    }
    if (previous && previous !== country) {
      findings.push(`country changed ${previous} -> ${country}`);
      actions.push(config.countryChangeAction);
    }
  }

  // (b) VPN / proxy (optional)
  const vpn = await checkVpn(config, ip);
  if (vpn && vpn.flagged) {
    findings.push(`VPN/proxy detected${vpn.detail ? ` (${vpn.detail})` : ''}`);
    actions.push(config.vpnAction);
  }

  // Remember state for next time.
  if (!isPrivateIp(ip)) await addToIpIndex(moduleId, ip, player);
  if (country) await writeLastCountry(moduleId, player.id, country);

  if (findings.length === 0) {
    console.log(`ip-watch: ${player.name} new IP ${shownIp}${country ? ` (${country})` : ''}: nothing suspicious`);
    return;
  }

  const action = strongestAction(actions);
  let outcome = null;
  if (action !== 'alert') {
    try {
      outcome = await applyAction(gameServerId, player.id, config, action);
    } catch (err) {
      console.log(`ip-watch: ${action} failed: ${err.message}`);
      outcome = `${action} FAILED`;
    }
  }

  const suffix = outcome ? ` -> ${outcome}` : '';
  await sendAlert(gameServerId, config, `${player.name}: ${findings.join('; ')}${suffix}`);
}

await main();
