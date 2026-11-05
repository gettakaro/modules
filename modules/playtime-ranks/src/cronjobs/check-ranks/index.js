import { data, takaro } from '@takaro/helpers';
import { createContext, evaluatePlayer, getLadder } from './rank-helpers.js';

const PAGE_SIZE = 100;

async function main() {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig;
  if (getLadder(config).length === 0) {
    console.log('playtime-ranks: no ranks configured, nothing to do');
    return;
  }

  const ctx = createContext(gameServerId);
  let page = 0;
  let checked = 0;
  let promoted = 0;
  let failed = 0;

  for (;;) {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], online: [true] },
      page,
      limit: PAGE_SIZE,
    });
    const pogs = res.data.data;

    // Sequential on purpose: keeps outbound requests well below the sandbox limit.
    for (const pog of pogs) {
      try {
        const result = await evaluatePlayer({ ctx, moduleId: mod.moduleId, config, pog });
        checked++;
        if (result.promoted) promoted++;
      } catch (err) {
        failed++;
        console.error(`playtime-ranks: failed to check player ${pog.playerId}: ${err}`);
      }
    }

    if (pogs.length < PAGE_SIZE) break;
    page++;
  }

  console.log(`playtime-ranks: checked=${checked} promoted=${promoted} failed=${failed}`);
}

await main();
