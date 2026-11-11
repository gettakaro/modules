import { data } from '@takaro/helpers';
import { isExempt, sendAlert } from './ip-watch-helpers.js';

async function main() {
  const { gameServerId, player, pog, eventData, module: mod } = data;
  const config = mod.userConfig;

  if (!config.nameChangeAlert) {
    console.log('ip-watch: name change alerts are off');
    return;
  }
  if (!player || isExempt(player, pog, config)) {
    console.log('ip-watch: no player or exempt, skipping');
    return;
  }

  const oldName = (eventData && eventData.oldName) || 'unknown';
  const newName = (eventData && eventData.newName) || player.name;
  await sendAlert(gameServerId, config, `Name change: ${oldName} -> ${newName}`);
}

await main();
