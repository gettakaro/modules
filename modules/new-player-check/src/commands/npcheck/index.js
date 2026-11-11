import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';
import { PERM, checkPlayer, getStatus, isExempt, summarize } from './npcheck-core.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  if (!checkPermission(pog, PERM.manage)) {
    throw new TakaroUserError('You do not have permission to use npcheck.');
  }
  const target = args.player;
  if (!target || !target.playerId) {
    throw new TakaroUserError('Usage: npcheck <player>');
  }

  const cfg = mod.userConfig;
  const name = (await takaro.player.playerControllerGetOne(target.playerId)).data.data.name;
  const result = await checkPlayer(gameServerId, target.playerId, cfg);
  const status = await getStatus(gameServerId, target.playerId, mod.moduleId);

  const notes = [];
  if (status) notes.push(`status: ${status.value.status}`);
  if (isExempt(result.pog)) notes.push('exempt from automatic checks');
  await pog.pm(summarize(name, result, cfg));
  if (notes.length) await pog.pm(`[New player check] ${name}: ${notes.join(', ')}`);
  console.log(summarize(name, result, cfg));
}

await main();
