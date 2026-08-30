import { data, takaro, TakaroUserError } from '@takaro/helpers';
import {
  applyPackageToPog,
  clearWorldEvent,
  findBuffPackage,
  formatDuration,
  getOnlinePogs,
  isWorldEventExpired,
  readWorldEvent,
  removePackageFromPog,
  resolveWorldEventPackage,
  writeWorldEvent,
} from './buff-manager-helpers.js';

async function broadcast(gameServerId, message, enabled) {
  if (!enabled) return;
  try {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message });
  } catch (err) {
    console.log(`⚠️ Failed to broadcast world event message: ${err.message}`);
  }
}

function getEventDurationMinutes(config, pkg, argDuration) {
  const requested = Number(argDuration);
  if (Number.isFinite(requested) && requested >= 0) return requested;

  const configuredDefault = Number(config.worldEventDefaultDuration);
  if (Number.isFinite(configuredDefault) && configuredDefault >= 0) return configuredDefault;

  const packageDuration = Number(pkg.duration);
  return Number.isFinite(packageDuration) && packageDuration >= 0 ? packageDuration : 60;
}

async function startWorldEvent(gameServerId, module, pog, config, buffPackages, packageName, durationArg) {
  if (!packageName) {
    throw new TakaroUserError('Usage: /buffevent start <packageName|random> [durationMinutes]');
  }

  const pkg = resolveWorldEventPackage(buffPackages, packageName);
  if (!pkg) {
    const availablePackages = buffPackages.map((p) => p.commandName).join(', ');
    throw new TakaroUserError(`Buff package "${packageName}" not found. Available: ${availablePackages}. Use "random" to pick one.`);
  }

  const { state: existingState } = await readWorldEvent(gameServerId, module.moduleId);
  if (existingState && !isWorldEventExpired(existingState)) {
    const existingPkg = findBuffPackage(buffPackages, existingState.packageName);
    const existingName = existingPkg?.displayName || existingState.packageName;
    throw new TakaroUserError(`A world event is already active: ${existingName}. Stop it first with /buffevent stop.`);
  }

  const durationMinutes = getEventDurationMinutes(config, pkg, durationArg);
  const now = Date.now();
  const expiresAt = durationMinutes > 0 ? now + durationMinutes * 60000 : 0;
  const eventState = {
    packageName: pkg.commandName,
    startedAt: now,
    expiresAt,
  };

  await writeWorldEvent(gameServerId, module.moduleId, eventState);

  const onlinePogs = await getOnlinePogs(gameServerId);
  let totalBuffsApplied = 0;
  let playersApplied = 0;

  console.log(`🌍 Starting world buff event: ${pkg.displayName}`);
  console.log(`   Online players: ${onlinePogs.length}`);
  console.log(`   Duration: ${formatDuration(durationMinutes)}`);

  for (const onlinePog of onlinePogs) {
    const applied = await applyPackageToPog(gameServerId, pkg, onlinePog);
    if (applied > 0) playersApplied++;
    totalBuffsApplied += applied;
  }

  await broadcast(
    gameServerId,
    `World event started: ${pkg.displayName}${durationMinutes > 0 ? ` for ${formatDuration(durationMinutes)}` : ''}. Buffs apply to online players and late joiners.`,
    config.announceWorldEvents !== false,
  );

  await pog.pm(`Started world event: ${pkg.displayName}. Applied ${totalBuffsApplied} buff(s) to ${playersApplied}/${onlinePogs.length} online player(s).`);
}

async function stopWorldEvent(gameServerId, module, pog, config, buffPackages) {
  const { state } = await readWorldEvent(gameServerId, module.moduleId);
  if (!state) throw new TakaroUserError('No world event is active.');

  const pkg = findBuffPackage(buffPackages, state.packageName);
  if (!pkg) {
    await clearWorldEvent(gameServerId, module.moduleId);
    throw new TakaroUserError(`World event package "${state.packageName}" is no longer configured. Cleared the stale event state.`);
  }

  const onlinePogs = await getOnlinePogs(gameServerId);
  let totalBuffsRemoved = 0;
  let playersRemoved = 0;

  console.log(`🌍 Stopping world buff event: ${pkg.displayName}`);
  console.log(`   Online players: ${onlinePogs.length}`);

  for (const onlinePog of onlinePogs) {
    const removed = await removePackageFromPog(gameServerId, pkg, onlinePog);
    if (removed > 0) playersRemoved++;
    totalBuffsRemoved += removed;
  }

  await clearWorldEvent(gameServerId, module.moduleId);
  await broadcast(gameServerId, `World event ended: ${pkg.displayName}.`, config.announceWorldEvents !== false);
  await pog.pm(`Stopped world event: ${pkg.displayName}. Removed ${totalBuffsRemoved} buff(s) from ${playersRemoved}/${onlinePogs.length} online player(s).`);
}

async function showWorldEventStatus(gameServerId, module, pog, buffPackages) {
  const { state } = await readWorldEvent(gameServerId, module.moduleId);
  if (!state) {
    await pog.pm('No world event is active.');
    return;
  }

  if (isWorldEventExpired(state)) {
    await pog.pm('A world event is expired and will be cleaned up by the next maintenance run. Use /buffevent stop to clear it now.');
    return;
  }

  const pkg = findBuffPackage(buffPackages, state.packageName);
  const name = pkg?.displayName || state.packageName;
  const durationText = Number(state.expiresAt) > 0
    ? `expires in ${formatDuration(Math.ceil((Number(state.expiresAt) - Date.now()) / 60000))}`
    : 'permanent until stopped';
  await pog.pm(`Active world event: ${name} (${durationText}).`);
}

async function main() {
  const { gameServerId, pog, arguments: args, module } = data;
  const config = module.userConfig;
  const buffPackages = config.buffPackages || [];

  if (buffPackages.length === 0) {
    throw new TakaroUserError('No buff packages are configured.');
  }

  const action = String(args.action || 'status').trim().toLowerCase();
  const packageName = String(args.packageName || '').trim();
  const durationMinutes = args.durationMinutes;

  if (action === 'start') {
    await startWorldEvent(gameServerId, module, pog, config, buffPackages, packageName, durationMinutes);
    return;
  }

  if (action === 'stop') {
    await stopWorldEvent(gameServerId, module, pog, config, buffPackages);
    return;
  }

  if (action === 'status') {
    await showWorldEventStatus(gameServerId, module, pog, buffPackages);
    return;
  }

  throw new TakaroUserError('Unknown action. Usage: /buffevent <start|stop|status> [packageName|random] [durationMinutes]');
}

await main();
