import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';
import { KEYS, PERM, describe, evaluate, exemptReason, getJson, getProfile, steamIdOf } from './spg-core.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  if (!checkPermission(pog, PERM.manage)) {
    throw new TakaroUserError('You do not have permission to use sgcheck.');
  }
  const target = args.player;
  if (!target || !target.playerId) throw new TakaroUserError('Usage: sgcheck <player>');

  const cfg = mod.userConfig;
  const moduleId = mod.moduleId;
  const player = (await takaro.player.playerControllerGetOne(target.playerId)).data.data;
  const steamId = await steamIdOf(player);
  if (!steamId) {
    await pog.pm(`[Steam guard] ${player.name} has no Steam ID, so there is nothing to check.`);
    return;
  }

  // Always fresh: an admin asking wants the current profile. This also refreshes the cache.
  const { profile, error } = await getProfile({
    gameServerId,
    moduleId,
    playerId: player.id,
    steamId,
    cfg,
    useCache: false,
  });
  if (!profile) {
    await pog.pm(`[Steam guard] ${player.name}: could not check. ${error}.`);
    return;
  }

  const nowMs = Date.now();
  const findings = evaluate(cfg, profile, nowMs);
  const verdict = findings.length ? `FLAGGED: ${findings.map((f) => f.text).join('; ')}` : 'passes all rules';
  await pog.pm(`[Steam guard] ${player.name} (${steamId}): ${describe(profile, nowMs)} - ${verdict}`);

  const notes = [];
  if (error) notes.push(`Steam API failed, used Takaro's stored data: ${error}`);
  const targetPog = (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, player.id)).data
    .data;
  const reason = await exemptReason({
    pog: targetPog,
    steamId,
    cfg,
    gameServerId,
    playerId: player.id,
    moduleId,
  });
  if (reason) notes.push(`not checked on join: ${reason}`);
  const status = await getJson(KEYS.status, gameServerId, player.id, moduleId);
  if (status) notes.push(`last join check: ${status.status}`);
  if (notes.length) await pog.pm(`[Steam guard] ${player.name}: ${notes.join(', ')}`);
}

await main();
