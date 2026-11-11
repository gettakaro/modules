import { data, TakaroUserError, checkPermission } from '@takaro/helpers';
import { discordLog, getPlayerName, loadRecord, pruneExpired, saveRecord } from './warn-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;
  const cfg = mod.userConfig;

  if (!checkPermission(pog, 'WARN_MANAGE')) {
    throw new TakaroUserError('You do not have permission to remove warnings.');
  }

  const target = args.player;
  if (!target || !target.playerId) {
    throw new TakaroUserError('Please name a valid player.');
  }
  const id = Number(args.id);
  if (!Number.isInteger(id) || id < 1) {
    throw new TakaroUserError('Please give the warning id, for example: unwarn Bob 2');
  }

  const targetName = await getPlayerName(target.playerId, target.name || 'Unknown player');
  const { variableId, record } = await loadRecord(gameServerId, mod.moduleId, target.playerId);
  pruneExpired(record, cfg.warningExpiryDays, Date.now());

  const index = record.warnings.findIndex((w) => Number(w.id) === id);
  if (index === -1 || !variableId) {
    throw new TakaroUserError(`${targetName} has no active warning #${id}.`);
  }
  const [removed] = record.warnings.splice(index, 1);
  await saveRecord(gameServerId, mod.moduleId, target.playerId, variableId, record);

  const count = record.warnings.length;
  await pog.pm(`Removed warning #${id} from ${targetName}. Active warnings: ${count}.`);
  await discordLog(
    cfg.discordChannelId,
    `✅ **${player.name}** removed warning #${id} from **${targetName}** (${count} active). It was: ${removed.reason}`,
  );
}

await main();
