import { data, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  applyEscalation,
  broadcast,
  describeStep,
  discordLog,
  getPlayerName,
  getPrefix,
  loadRecord,
  nextEscalation,
  parseReason,
  pickEscalation,
  pruneExpired,
  renderTemplate,
  saveRecord,
  sendTo,
} from './warn-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod, chatMessage } = data;
  const cfg = mod.userConfig;

  if (!checkPermission(pog, 'WARN_ISSUE')) {
    throw new TakaroUserError('You do not have permission to warn players.');
  }

  const target = args.player;
  if (!target || !target.playerId) {
    throw new TakaroUserError('Please name a valid player to warn.');
  }
  if (target.playerId === player.id) {
    throw new TakaroUserError('You cannot warn yourself.');
  }

  const reason = parseReason(chatMessage?.msg, args.reason);
  if (!reason) {
    throw new TakaroUserError('Please give a reason for the warning.');
  }

  const now = Date.now();
  const moduleId = mod.moduleId;
  const [targetName, prefix, loaded] = await Promise.all([
    getPlayerName(target.playerId, target.name || 'Unknown player'),
    getPrefix(gameServerId),
    loadRecord(gameServerId, moduleId, target.playerId),
  ]);
  const { record } = loaded;
  pruneExpired(record, cfg.warningExpiryDays, now);

  const warning = {
    id: record.nextId,
    reason,
    staffId: player.id,
    staffName: player.name,
    createdAt: new Date(now).toISOString(),
    delivered: false,
  };
  record.nextId += 1;
  record.warnings.push(warning);
  const count = record.warnings.length;

  const values = { player: targetName, staff: player.name, reason, count, id: warning.id, prefix };

  if (target.online !== false) {
    try {
      await sendTo(gameServerId, target.gameId, renderTemplate(cfg.warnMessage, values));
      warning.delivered = true;
    } catch (err) {
      console.error(`warn-system: PM to ${targetName} failed: ${err}`);
    }
  }

  await saveRecord(gameServerId, moduleId, target.playerId, loaded.variableId, record);

  if (cfg.broadcastWarnings) {
    await broadcast(gameServerId, renderTemplate(cfg.broadcastMessage, values));
  }

  const step = pickEscalation(cfg.escalation, count);
  let escalationText = '';
  if (step) {
    if (warning.delivered && step.action !== 'kick') {
      try {
        await sendTo(gameServerId, target.gameId, `You reached ${count} warnings: ${describeStep(step)}.`);
      } catch {
        // The ban still happens; the notice is best effort.
      }
    }
    const result = await applyEscalation({ step, gameServerId, target, targetName, count, reason, now });
    escalationText = result.text;
  }

  const staffLines = [`Warned ${targetName} (#${warning.id}): ${reason}. Active warnings: ${count}.`];
  if (!warning.delivered) staffLines.push(`${targetName} is offline and will be told on next join.`);
  if (escalationText) {
    staffLines.push(escalationText);
  } else {
    const next = nextEscalation(cfg.escalation, count);
    if (next) staffLines.push(`Next step at ${next.warnings} warnings: ${describeStep(next)}.`);
  }
  for (const line of staffLines) {
    await pog.pm(line);
  }

  const log = [`⚠️ **${targetName}** warned by **${player.name}** (#${warning.id}, ${count} active): ${reason}`];
  if (escalationText) log.push(`➡️ ${escalationText}`);
  await discordLog(cfg.discordChannelId, log.join('\n'));
}

await main();
