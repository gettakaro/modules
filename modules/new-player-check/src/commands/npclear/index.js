import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';
import { KEYS, PERM, deleteVar, findRole, setVar } from './npcheck-core.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  if (!checkPermission(pog, PERM.manage)) {
    throw new TakaroUserError('You do not have permission to use npclear.');
  }
  const target = args.player;
  if (!target || !target.playerId) {
    throw new TakaroUserError('Usage: npclear <player>');
  }

  const cfg = mod.userConfig;
  const moduleId = mod.moduleId;
  const name = (await takaro.player.playerControllerGetOne(target.playerId)).data.data.name;
  await setVar(
    KEYS.status,
    { status: 'reviewed', by: pog.playerId, at: new Date().toISOString() },
    gameServerId,
    target.playerId,
    moduleId,
  );
  await deleteVar(KEYS.pending, gameServerId, target.playerId, moduleId);

  let roleNote = '';
  try {
    const role = await findRole(cfg.flagRoleName);
    const targetPog = (
      await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, target.playerId)
    ).data.data;
    const assignment = role && (targetPog.roles || []).find((r) => r.roleId === role.id);
    if (assignment) {
      await takaro.player.playerControllerRemoveRole(target.playerId, role.id, {
        ...(assignment.gameServerId ? { gameServerId: assignment.gameServerId } : {}),
      });
      roleNote = ` Role ${role.name} removed.`;
    }
  } catch (err) {
    console.log(`npcheck: could not remove the flag role: ${err}`);
  }

  await pog.pm(`[New player check] ${name} is marked as reviewed and will not be checked again.${roleNote}`);
}

await main();
