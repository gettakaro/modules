import { data } from '@takaro/helpers';
import { deliverPending } from './rewards.js';

async function main() {
  if ((await deliverPending(data.pog, data.player)) === 0) {
    await data.pog.pm('You have no vote rewards waiting.');
  }
}

await main();
