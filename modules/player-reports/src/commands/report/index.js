import { data, takaro, TakaroUserError } from '@takaro/helpers';
import {
  COOLDOWN_KEY,
  readJson,
  writeJson,
  nextTicketId,
  saveTicket,
  getOpenIndex,
  saveOpenIndex,
  getPrefix,
  textAfter,
  truncate,
  positionOf,
  formatPosition,
  resolvePlayer,
  getOnlineReceivers,
  getRecentChat,
  pmPlayer,
} from './report-helpers.js';

async function main() {
  const { gameServerId, player, pog, module: mod, arguments: args, chatMessage } = data;
  const moduleId = mod.moduleId;
  const cfg = mod.userConfig;
  const prefix = await getPrefix(gameServerId);

  const text = textAfter(chatMessage, 1, args.text);
  if (!text) {
    throw new TakaroUserError(
      `Usage: ${prefix}report <player> <reason>` +
        (cfg.allowGeneralReports ? ` or ${prefix}report <reason>` : ''),
    );
  }

  // Anti-spam: cooldown
  const now = Date.now();
  const last = await readJson(gameServerId, moduleId, COOLDOWN_KEY, player.id, null);
  if (last && cfg.cooldownSeconds > 0) {
    const waitMs = new Date(last).getTime() + cfg.cooldownSeconds * 1000 - now;
    if (waitMs > 0) {
      throw new TakaroUserError(`Please wait ${Math.ceil(waitMs / 1000)}s before sending another report.`);
    }
  }

  // Anti-spam: max open reports
  const openIndex = await getOpenIndex(gameServerId, moduleId);
  const myOpen = openIndex.filter((t) => t.reporterId === player.id).length;
  if (cfg.maxOpenReportsPerPlayer > 0 && myOpen >= cfg.maxOpenReportsPerPlayer) {
    throw new TakaroUserError(
      `You already have ${myOpen} open report(s). Please wait until staff handles them.`,
    );
  }

  // Is the first word a player?
  const words = text.split(/\s+/);
  const resolved = await resolvePlayer(gameServerId, words[0]);
  if (resolved && resolved.ambiguous) {
    throw new TakaroUserError(
      `"${words[0]}" matches several players: ${resolved.ambiguous.slice(0, 5).join(', ')}. Type more of the name.`,
    );
  }

  let target = null;
  let reason = text;
  if (resolved) {
    if (resolved.player.id === player.id) {
      throw new TakaroUserError('You cannot report yourself.');
    }
    reason = words.slice(1).join(' ').trim();
    if (!reason) {
      throw new TakaroUserError(`Please add a reason: ${prefix}report ${resolved.player.name} <reason>`);
    }
    target = resolved;
  } else if (!cfg.allowGeneralReports) {
    throw new TakaroUserError(`Player "${words[0]}" not found. Usage: ${prefix}report <player> <reason>`);
  }

  if (reason.length < cfg.minReasonLength) {
    throw new TakaroUserError(`Please describe the problem (at least ${cfg.minReasonLength} characters).`);
  }
  reason = truncate(reason, cfg.maxReasonLength);

  // Context
  const chat = target ? await getRecentChat(gameServerId, target.player.id, cfg.chatContextLines) : [];
  const id = await nextTicketId(gameServerId, moduleId);
  const createdAt = new Date(now).toISOString();
  const ticket = {
    id,
    status: 'open',
    createdAt,
    reason,
    reporter: {
      playerId: player.id,
      name: player.name,
      position: positionOf(pog),
    },
    target: target
      ? {
          playerId: target.player.id,
          name: target.player.name,
          online: Boolean(target.pog && target.pog.online),
          position: target.pog && target.pog.online ? positionOf(target.pog) : null,
        }
      : null,
    chat,
  };

  await saveTicket(gameServerId, moduleId, ticket);
  openIndex.push({
    id,
    reporterId: player.id,
    reporterName: player.name,
    targetName: ticket.target ? ticket.target.name : null,
    reason: truncate(reason, 60),
    createdAt,
  });
  await saveOpenIndex(gameServerId, moduleId, openIndex);
  await writeJson(gameServerId, moduleId, COOLDOWN_KEY, player.id, createdAt);

  const about = ticket.target ? ` about ${ticket.target.name}` : '';
  await player.pm(`Report #${id}${about} sent. Staff will look at it. Thank you!`);

  // Alert staff in game
  const alert = `[Report #${id}] ${player.name}${about}: ${truncate(reason, 80)} - ${prefix}reportview ${id}`;
  let notified = 0;
  try {
    const receivers = await getOnlineReceivers(gameServerId);
    for (const receiver of receivers) {
      if (receiver.playerId === player.id) continue;
      await pmPlayer(gameServerId, receiver.gameId, alert);
      notified++;
    }
  } catch (err) {
    console.error(`player-reports: failed to alert staff: ${err}`);
  }
  console.log(`player-reports: ticket #${id} created, ${notified} staff notified in game`);

  // Optional Discord alert
  const channelId = String(cfg.discordChannelId ?? '').trim();
  if (channelId) {
    try {
      const fields = [
        { name: 'Reporter', value: `${player.name} @ ${formatPosition(ticket.reporter.position)}`, inline: true },
      ];
      if (ticket.target) {
        fields.push({
          name: 'Reported player',
          value: `${ticket.target.name} (${ticket.target.online ? `online @ ${formatPosition(ticket.target.position)}` : 'offline'})`,
          inline: true,
        });
      }
      if (chat.length > 0) {
        fields.push({
          name: `Last ${chat.length} chat line(s) of ${ticket.target.name}`,
          value: truncate(chat.map((c) => c.msg).join('\n'), 1000),
        });
      }
      await takaro.discord.discordControllerSendMessage(channelId, {
        embed: {
          title: `Report #${id}${about}`,
          description: truncate(reason, 4000),
          color: 15158332,
          fields,
          timestamp: createdAt,
        },
      });
    } catch (err) {
      console.error(`player-reports: Discord alert failed (check channel id and bot access): ${err}`);
    }
  }
}

await main();
