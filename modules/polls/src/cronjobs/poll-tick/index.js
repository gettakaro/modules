import { data } from '@takaro/helpers';
import { getActivePoll, closePoll } from './polls-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const active = await getActivePoll(gameServerId, mod.moduleId);
  if (!active) return;
  if (new Date(active.poll.endsAt).getTime() > Date.now()) return;
  await closePoll(gameServerId, mod, active, 'timeout');
}

await main();
