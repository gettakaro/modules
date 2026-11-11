import { data, TakaroUserError } from '@takaro/helpers';
import { addIgnore, getPrefix, KEYS, loadIgnore, resolvePlayerByName, writeVar } from './pm-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;
  const input = String(args.player ?? '').trim();
  const ignore = await loadIgnore(gameServerId, mod.moduleId, player.id);

  // Takaro needs a non-empty default for an optional argument, so a bare `ignore` arrives as "list".
  if (!input || input.toLowerCase() === 'list') {
    const prefix = await getPrefix(gameServerId);
    if (!ignore.list.length) {
      await pog.pm(`You are not ignoring anyone. Use ${prefix}ignore <player> to block their messages.`);
      return;
    }
    await pog.pm(`Ignored (${ignore.list.length}): ${ignore.list.map((e) => e.name).join(', ')}`);
    await pog.pm(`Use ${prefix}unignore <player> to allow them again.`);
    return;
  }

  const found = await resolvePlayerByName(gameServerId, input);
  if (found.error) throw new TakaroUserError(found.error);
  if (found.playerId === player.id) throw new TakaroUserError('You cannot ignore yourself.');

  const result = addIgnore(ignore.list, { playerId: found.playerId, name: found.name });
  if (result.full) throw new TakaroUserError('Your ignore list is full. Remove someone with unignore first.');
  if (!result.added) {
    await pog.pm(`You are already ignoring ${found.name}.`);
    return;
  }
  await writeVar(gameServerId, mod.moduleId, player.id, KEYS.ignore, ignore.id, result.list);
  await pog.pm(`You now ignore ${found.name}. Their private messages and mail are blocked.`);
}

await main();
