import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import {
  MANAGE_PERMISSION,
  describeReward,
  doorDate,
  eventName,
  formatDuration,
  getTextContext,
  offsetLabel,
  resolveEvent,
  rewardForDoor,
} from './advent-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod, arguments: args } = data;
  const config = mod.userConfig;
  if (!checkPermission(pog, MANAGE_PERMISSION)) {
    throw new TakaroUserError('Only admins can preview the calendar.');
  }
  const nowMs = Date.now();
  const name = eventName(config);
  const { prefix, currency } = await getTextContext(gameServerId);
  const event = resolveEvent(config, nowMs);
  if (event.status === 'invalid') {
    throw new TakaroUserError(
      `Start date '${config.startDate}' is not valid. Use MM-DD (every year, e.g. 12-01) or YYYY-MM-DD (one year).`,
    );
  }
  const days = event.totalDays;
  const door = Math.floor(Number(args.day) || 0);

  if (door > 0) {
    if (door > days) throw new TakaroUserError(`Pick a door from 1 to ${days}.`);
    const reward = rewardForDoor(config, door, days);
    const tag = reward.custom ? ' (custom)' : door === days ? ' (last day)' : '';
    await pog.pm(`Door ${door} (${doorDate(event, door)})${tag}: ${await describeReward(reward, currency)}.`);
    return;
  }

  let status;
  if (event.status === 'before') status = `starts in ${formatDuration(event.startsAtMs - nowMs)}`;
  else if (event.status === 'after') status = 'is over';
  else status = `is running, today is door ${event.today}`;
  await pog.pm(
    `${name}: ${days} doors, ${doorDate(event, 1)} to ${doorDate(event, days)} (${offsetLabel(config)}). It ${status}.`,
  );
  await pog.pm(`Normal door: ${await describeReward(rewardForDoor({ ...config, doors: [] }, 1, days + 1), currency)}.`);
  await pog.pm(`Last door (${days}): ${await describeReward(rewardForDoor({ ...config, doors: [] }, days, days), currency)}.`);
  const custom = (Array.isArray(config.doors) ? config.doors : [])
    .map((d) => Number(d && d.day))
    .filter((d) => d >= 1 && d <= days)
    .sort((a, b) => a - b);
  if (custom.length > 0) await pog.pm(`Custom doors: ${custom.join(', ')}. Check one with ${prefix}adventpreview <door>.`);
  const missedRule = 'Missed doors stay locked, except for players with the catch-up permission.';
  await pog.pm(`Broadcast: ${config.broadcast || 'lastDay'}. ${missedRule}`);
}

await main();
