import { data } from '@takaro/helpers';
import { deliverPendingItems, eventName, getProgress, getTextContext, resolveEvent } from './advent-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  try {
    const delivered = await deliverPendingItems(gameServerId, moduleId, pog.playerId);
    if (delivered > 0) await pog.pm(`You got ${delivered} advent calendar item(s) that could not be given before.`);
  } catch (err) {
    console.error(`advent-calendar: delivering pending items failed: ${err}`);
  }

  if (config.remindOnJoin === false) return;
  const event = resolveEvent(config, Date.now());
  if (event.status !== 'running') return;
  const progress = await getProgress(event, gameServerId, moduleId, pog.playerId);
  if (progress.opened.includes(event.today)) return;
  const { prefix } = await getTextContext(gameServerId);
  await pog.pm(`Door ${event.today} of the ${eventName(config)} is waiting for you. Type ${prefix}advent to open it!`);
}

await main();
