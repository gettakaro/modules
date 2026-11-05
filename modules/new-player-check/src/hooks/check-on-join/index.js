import { data } from '@takaro/helpers';
import {
  KEYS,
  PENDING_MS,
  checkPlayer,
  getStatus,
  handleResult,
  isExempt,
  isWatched,
  needsInventory,
  setVar,
} from './npcheck-core.js';

async function main() {
  const { gameServerId, player, pog, module: mod } = data;
  const cfg = mod.userConfig;
  const moduleId = mod.moduleId;

  if (!isWatched(pog, cfg, Date.now())) return;
  if (isExempt(pog)) {
    console.log(`npcheck: ${player.name} is exempt`);
    return;
  }
  const status = await getStatus(gameServerId, player.id, moduleId);
  if (status && status.value.status === 'reviewed') {
    console.log(`npcheck: ${player.name} was reviewed by an admin; not checked`);
    return;
  }

  const result = await checkPlayer(gameServerId, player.id, cfg);
  if (needsInventory(cfg) && !result.inventory.known) {
    // Takaro has no inventory snapshot of a brand-new player yet; the cron job tries again.
    await setVar(
      KEYS.pending,
      { since: new Date().toISOString() },
      gameServerId,
      player.id,
      moduleId,
      new Date(Date.now() + PENDING_MS).toISOString(),
    );
    console.log(`npcheck: inventory of ${player.name} not known yet; will retry`);
  }
  await handleResult({ gameServerId, moduleId, cfg, playerId: player.id, name: player.name, result });
}

await main();
