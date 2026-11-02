import { takaro, data, TakaroUserError, checkPermission } from '@takaro/helpers';

function getWaypointName(name) {
  return `waypoint ${name}`;
}

async function main() {
  const { pog, gameServerId, trigger, module, itemId } = data;

  const triggeredCommand = module.version.commands.find((command) => command.id === itemId);

  if (!triggeredCommand) {
    throw new Error('Waypoint not found.');
  }

  if (!triggeredCommand.name.includes(`server ${gameServerId}`)) {
    console.log(`Waypoint ${trigger} is not for this server.`);
    return;
  }

  if (!checkPermission(pog, `WAYPOINTS_USE_${trigger.toUpperCase()}_${gameServerId}`)) {
    throw new TakaroUserError(`You are not allowed to use the waypoint ${trigger}.`);
  }

  // By registry source, not by name: the official module is renamed (e.g. `teleports-1a2b3c4d`)
  // when a Domain already has its own module called `teleports`.
  const candidates = (
    await takaro.module.moduleControllerSearch({
      filters: { source: ['official'] },
      search: { name: ['teleports'] },
    })
  ).data.data;
  const teleportsModule = candidates.find((mod) => mod.latestVersion?.sourceModuleName === 'teleports');

  if (!teleportsModule) {
    throw new TakaroUserError('The official teleports module is not available, so waypoints cannot be used.');
  }

  const variable = await takaro.variable.variableControllerSearch({
    filters: {
      key: [getWaypointName(trigger)],
      gameServerId: [gameServerId],
      moduleId: [teleportsModule.id],
    },
  });

  if (variable.data.data.length === 0) {
    throw new TakaroUserError(`Waypoint ${trigger} does not exist.`);
  }

  const waypoint = JSON.parse(variable.data.data[0].value);

  await takaro.gameserver.gameServerControllerTeleportPlayer(gameServerId, pog.playerId, {
    x: waypoint.x,
    y: waypoint.y,
    z: waypoint.z,
    dimension: waypoint.dimension,
  });

  await pog.pm(`Teleported to waypoint ${trigger}.`);
}

await main();
