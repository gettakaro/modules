import { data } from '@takaro/helpers';
import { bumpSignal, readConfig } from './stx-helpers.js';

async function main() {
  const { gameServerId, eventData, module: mod } = data;
  const command = eventData && eventData.command;
  if (!command) return;
  if (eventData.result && eventData.result.success === false) return;
  const cfg = readConfig(mod.userConfig);
  const name = String(command.name || '').toLowerCase();
  const trigger = String(command.trigger || '').toLowerCase();
  const isTravel = cfg.travelCommands.length === 0 || cfg.travelCommands.some((w) => name.includes(w) || trigger.includes(w));
  if (!isTravel) return;
  await bumpSignal(gameServerId, mod.moduleId, 'travel');
}

await main();
