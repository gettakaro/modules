import { data } from '@takaro/helpers';
import { getPrefix, loadRecord, pruneExpired, saveRecord } from './warn-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod } = data;
  const cfg = mod.userConfig;
  if (!cfg.notifyOnJoin || !player) return;

  const { variableId, record } = await loadRecord(gameServerId, mod.moduleId, player.id);
  if (!variableId) return;

  pruneExpired(record, cfg.warningExpiryDays, Date.now());
  const missed = record.warnings.filter((w) => !w.delivered);
  if (missed.length === 0) return;

  const prefix = await getPrefix(gameServerId);
  await pog.pm(
    `While you were offline you received ${missed.length} warning${missed.length === 1 ? '' : 's'}. ` +
      `Active warnings: ${record.warnings.length}.`,
  );
  for (const w of missed.slice(-5)) {
    await pog.pm(`#${w.id} by ${w.staffName}: ${w.reason}`);
  }
  await pog.pm(`Type ${prefix}warnings to see all of them.`);

  missed.forEach((w) => {
    w.delivered = true;
  });
  await saveRecord(gameServerId, mod.moduleId, player.id, variableId, record);
}

await main();
