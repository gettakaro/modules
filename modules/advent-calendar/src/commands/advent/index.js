import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';
import {
  CATCH_UP_PERMISSION,
  claimDoor,
  describeReward,
  doorDate,
  eventName,
  fill,
  formatDuration,
  getProgress,
  getTextContext,
  giveReward,
  listDoors,
  releaseDoor,
  resolveEvent,
  rewardForDoor,
  saveProgress,
} from './advent-helpers.js';

/** Catch-up limit from the permission count. 0 or no count = unlimited. */
function catchUpLimit(pog) {
  const perm = checkPermission(pog, CATCH_UP_PERMISSION);
  if (!perm) return null;
  const count = Number(perm.count);
  return Number.isFinite(count) && count > 0 ? count : Infinity;
}

async function main() {
  const { gameServerId, player, pog, module: mod, arguments: args } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;
  const nowMs = Date.now();
  const name = eventName(config);
  const { prefix, currency } = await getTextContext(gameServerId);
  const event = resolveEvent(config, nowMs);

  if (event.status === 'invalid') {
    throw new TakaroUserError(`The ${name} is not set up correctly. Please tell an admin.`);
  }
  if (event.status === 'before') {
    await pog.pm(
      `The ${name} opens in ${formatDuration(event.startsAtMs - nowMs)} (${doorDate(event, 1)}). ${event.totalDays} doors to open, one per day!`,
    );
    return;
  }
  if (event.status === 'after') {
    const progress = await getProgress(event, gameServerId, moduleId, pog.playerId);
    await pog.pm(`The ${name} is over. You opened ${progress.opened.length} of ${event.totalDays} doors.`);
    return;
  }

  const { today, totalDays } = event;
  const requested = Math.floor(Number(args.day) || 0);
  const door = requested > 0 ? requested : today;
  const progress = await getProgress(event, gameServerId, moduleId, pog.playerId);
  const nextDoor = today < totalDays ? ` Next door in ${formatDuration(event.nextDoorMs - nowMs)}.` : '';

  if (door > totalDays) {
    throw new TakaroUserError(`Pick a door from 1 to ${totalDays}. Today is door ${today}.`);
  }
  if (door > today) {
    throw new TakaroUserError(
      `Door ${door} opens on ${doorDate(event, door)}, in ${formatDuration(event.nextDoorMs - nowMs + (door - today - 1) * 86400000)}. Today is door ${today}.`,
    );
  }
  if (progress.opened.includes(door)) {
    throw new TakaroUserError(
      door === today
        ? `You already opened door ${door} today.${nextDoor} Doors opened: ${progress.opened.length}/${totalDays}.`
        : `You already opened door ${door}. Type ${prefix}advent to open today's door.`,
    );
  }

  const isCatchUp = door < today;
  if (isCatchUp) {
    const limit = catchUpLimit(pog);
    if (limit === null) {
      throw new TakaroUserError(`Door ${door} is locked: you missed that day. Only today's door (${today}) can be opened.`);
    }
    if (progress.catchUps >= limit) {
      throw new TakaroUserError(`You used all ${limit} of your catch-ups for missed doors.`);
    }
  }

  const claimId = await claimDoor(event, door, gameServerId, moduleId, pog.playerId, nowMs);
  if (!claimId) {
    throw new TakaroUserError(`You already opened door ${door}.`);
  }

  const reward = rewardForDoor(config, door, totalDays);
  let result;
  try {
    result = await giveReward({ gameServerId, moduleId, playerId: pog.playerId, reward, config, nowMs });
  } catch (err) {
    console.error(`advent-calendar: reward for door ${door} failed for ${player.name}: ${err}`);
    await releaseDoor(claimId);
    throw new TakaroUserError(`Door ${door} is stuck, nothing was given. Please try again in a moment.`);
  }

  progress.opened.push(door);
  if (isCatchUp) progress.catchUps += 1;
  await saveProgress(event, gameServerId, moduleId, pog.playerId, progress);

  const rewardText = await describeReward(reward, currency);
  const isLast = door === totalDays;
  await pog.pm(`${isCatchUp ? 'Catch-up! ' : ''}You opened door ${door} of the ${name}: ${rewardText}.`);
  if (result.itemsQueued > 0) {
    await pog.pm(`${result.itemsQueued} item(s) could not be given now. You get them when you join next time.`);
  }
  if (result.roleFailed) {
    await pog.pm('Your reward role could not be given. Please tell an admin.');
  }

  if (isLast) {
    await pog.pm(`That was the last door! You opened ${progress.opened.length} of ${totalDays} doors.`);
  } else {
    await pog.pm(`Doors opened: ${progress.opened.length}/${totalDays}.${door === today ? nextDoor : ''}`);
  }

  if (!isCatchUp) {
    const missed = [];
    for (let d = 1; d < today; d++) if (!progress.opened.includes(d)) missed.push(d);
    if (missed.length > 0) {
      const limit = catchUpLimit(pog);
      const left = limit === null ? 0 : limit - progress.catchUps;
      if (left > 0) {
        await pog.pm(`Missed doors: ${listDoors(missed)}. You can still open them: ${prefix}advent <door>.`);
      } else {
        await pog.pm(`Missed doors: ${listDoors(missed)} (locked). Come back every day!`);
      }
    }
  }

  const mode = config.broadcast || 'lastDay';
  if (mode === 'all' || (mode === 'lastDay' && isLast)) {
    const message = fill(config.broadcastMessage, {
      player: player.name,
      door,
      reward: rewardText,
      event: name,
      prefix,
      currency,
    });
    if (message) {
      await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message });
    }
  }
}

await main();
