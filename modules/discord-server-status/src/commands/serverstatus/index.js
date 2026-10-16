import { data } from '@takaro/helpers';
import { buildCurrentStatus } from './discord-server-status-helpers.js';

async function main() {
  const { gameServerId, module: mod, pog } = data;
  const config = mod.userConfig ?? {};
  const result = await buildCurrentStatus(gameServerId, config);
  console.log(`discord-server-status: game command requested, server=${result.serverName}, online=${result.onlineCount}`);
  await pog.pm(result.message);
}

await main();
