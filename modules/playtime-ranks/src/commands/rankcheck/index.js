import { data, takaro, TakaroUserError } from '@takaro/helpers';
import { createContext, evaluatePlayer, describeStatus, sendPm } from './rank-helpers.js';

async function main() {
  const { gameServerId, pog: admin, module: mod, arguments: args } = data;
  const target = args.player;
  if (!target || !target.playerId) {
    throw new TakaroUserError('Player not found. Usage: rankcheck <player>');
  }

  const ctx = createContext(gameServerId);
  const fresh = (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, target.playerId)).data.data;
  const player = await ctx.player(target.playerId);
  const result = await evaluatePlayer({ ctx, moduleId: mod.moduleId, config: mod.userConfig, pog: fresh });

  const changes = [];
  if (result.promoted) changes.push(`promoted to ${result.rank.name}`);
  if (result.rolesAdded.length) changes.push(`role added: ${result.rolesAdded.join(', ')}`);
  if (result.rolesRemoved.length) changes.push(`role removed: ${result.rolesRemoved.join(', ')}`);
  if (result.rewardsPaid > 0) changes.push(`paid ${result.rewardsPaid} ${await ctx.currencyName()}`);
  if (result.errors.length) changes.push(`problems: ${result.errors.join('; ')}`);

  const status = describeStatus(result, player.name);
  const summary = changes.length ? ` Changes: ${changes.join(', ')}.` : ' No changes needed.';
  await sendPm(gameServerId, admin.gameId, `${player.name}: ${status}${summary}`);
}

await main();
