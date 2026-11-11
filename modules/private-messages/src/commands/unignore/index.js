import { data, TakaroUserError } from '@takaro/helpers';
import { deleteVar, KEYS, loadIgnore, writeVar } from './pm-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;
  const input = String(args.player ?? '').trim().toLowerCase();
  if (!input) throw new TakaroUserError('Please name the player to unignore, or "all".');

  const ignore = await loadIgnore(gameServerId, mod.moduleId, player.id);
  if (input === 'all') {
    await deleteVar(ignore.id);
    await pog.pm(ignore.list.length ? `You no longer ignore anyone (${ignore.list.length} removed).` : 'You were not ignoring anyone.');
    return;
  }

  const exact = ignore.list.filter((e) => String(e.name).toLowerCase() === input);
  const partial = ignore.list.filter((e) => String(e.name).toLowerCase().includes(input));
  const matches = exact.length ? exact : partial;
  if (!matches.length) throw new TakaroUserError(`"${args.player}" is not on your ignore list.`);
  if (matches.length > 1) throw new TakaroUserError(`Several ignored players match "${args.player}". Please type more of the name.`);

  const rest = ignore.list.filter((e) => e.playerId !== matches[0].playerId);
  if (rest.length) {
    await writeVar(gameServerId, mod.moduleId, player.id, KEYS.ignore, ignore.id, rest);
  } else {
    await deleteVar(ignore.id);
  }
  await pog.pm(`You no longer ignore ${matches[0].name}.`);
}

await main();
