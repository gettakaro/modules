import { data } from '@takaro/helpers';
import { formatDuration, formatWipeTime, getSummary } from './wipeUtils.js';

async function main() {
  const { lastWipe, nextWipe } = await getSummary(data.gameServerId);
  const now = Date.now();

  if (lastWipe) {
    const since = now - Date.parse(lastWipe.completedAt ?? lastWipe.createdAt);
    const type = lastWipe.wipeTypeName ? ` (${lastWipe.wipeTypeName})` : '';
    await data.player.pm(`Last wipe: ${formatDuration(since)} ago${type}.`);
  } else {
    await data.player.pm('No wipe has been recorded on this server yet.');
  }

  if (!nextWipe) {
    await data.player.pm('No wipe is scheduled.');
    return;
  }
  const at = Date.parse(nextWipe.at);
  if (at > now) {
    await data.player.pm(
      `Next wipe: in ${formatDuration(at - now)}, ${formatWipeTime(nextWipe.at, nextWipe.timezone)} (${nextWipe.wipeTypeName}).`,
    );
  } else {
    await data.player.pm(`Next wipe: due now (${nextWipe.wipeTypeName}).`);
  }
}

await main();
