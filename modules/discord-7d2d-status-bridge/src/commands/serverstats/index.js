import { data } from '@takaro/helpers';
import { getStatus, renderTemplate } from './discord-7d2d-status-helpers.js';

async function main() {
  const { gameServerId, module: mod, player } = data;
  const config = mod.userConfig;
  const status = await getStatus(gameServerId, config);
  const message = renderTemplate(config.statusTemplate, status, config);
  await player.pm(message);
}

await main();
