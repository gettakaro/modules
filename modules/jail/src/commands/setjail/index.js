import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { JAIL_KEY, RELEASE_KEY, positionOf, setPoint, requireManage } from './jail-helpers.js';

async function main() {
  requireManage(checkPermission);

  const point = String(data.arguments.point ?? 'jail').toLowerCase();
  if (point !== 'jail' && point !== 'release') {
    throw new TakaroUserError("Use 'jail' or 'release', for example: setjail release");
  }

  const position = positionOf(data.pog);
  if (!position) {
    throw new TakaroUserError('Your position is not known yet. Move a bit and try again in a minute.');
  }

  await setPoint(point === 'jail' ? JAIL_KEY : RELEASE_KEY, position);
  const rounded = `${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)}`;
  await data.player.pm(
    point === 'jail' ? `Jail set at ${rounded}.` : `Release point set at ${rounded}.`,
  );
}

await main();
