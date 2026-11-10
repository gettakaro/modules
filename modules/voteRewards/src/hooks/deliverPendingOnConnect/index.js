import { data } from '@takaro/helpers';
import { deliverPending } from './rewards.js';

async function main() {
  await deliverPending(data.pog, data.player);
}

await main();
