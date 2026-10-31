import { data } from '@takaro/helpers';
import { ensureWaypointsModule } from './utils.js';

// The Waypoints Module declares these permissions, so they are matched against its id, not teleports'.
function holdsModulePermission(pog, code, moduleId) {
  return pog.roles.some(({ role }) =>
    role.permissions.some(
      ({ permission }) =>
        (permission.permission === 'ROOT' && !permission.module) ||
        (permission.permission === code && permission.module?.id === moduleId),
    ),
  );
}

async function main() {
  const { pog, gameServerId } = data;

  const { waypointsDefinition } = await ensureWaypointsModule();

  const allWaypoints = waypointsDefinition.latestVersion.commands;

  const waypointsWithPermission = allWaypoints
    .filter((waypoint) =>
      holdsModulePermission(
        pog,
        `WAYPOINTS_USE_${waypoint.trigger.toUpperCase()}_${gameServerId}`,
        waypointsDefinition.id,
      ),
    )
    .sort((a, b) => a.trigger.localeCompare(b.trigger));

  if (!waypointsWithPermission.length) {
    await pog.pm('There are no waypoints available.');
    return;
  }

  await pog.pm(`Available waypoints: ${waypointsWithPermission.map((waypoint) => waypoint.trigger).join(', ')}`);
}

await main();
