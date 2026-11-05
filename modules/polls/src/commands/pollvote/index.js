import { data, takaro, TakaroUserError } from '@takaro/helpers';
import { getSetting, getActivePoll, findPlayerVote, voteKey, broadcast } from './polls-helpers.js';

async function main() {
  const { player, gameServerId, arguments: args, module: mod } = data;
  const { moduleId, userConfig } = mod;
  const prefix = await getSetting('commandPrefix', gameServerId, '/');

  const active = await getActivePoll(gameServerId, moduleId);
  if (!active) throw new TakaroUserError('No poll is running right now.');
  const { poll } = active;

  // The cron job closes polls once a minute; refuse late votes in between.
  if (new Date(poll.endsAt).getTime() <= Date.now()) {
    throw new TakaroUserError('This poll has ended. Results are coming in a moment.');
  }

  const choice = Number(args.option);
  if (!Number.isInteger(choice) || choice < 1 || choice > poll.options.length) {
    throw new TakaroUserError(`Pick a number from 1 to ${poll.options.length}. See the options with ${prefix}poll.`);
  }
  const idx = choice - 1;

  const existing = await findPlayerVote(gameServerId, moduleId, poll.id, player.id);
  if (existing) {
    if (Number(JSON.parse(existing.value)) === idx) {
      await player.pm(`You already voted for ${choice}. ${poll.options[idx]}.`);
      return;
    }
    await takaro.variable.variableControllerUpdate(existing.id, { value: JSON.stringify(idx) });
    await player.pm(`Vote changed to ${choice}. ${poll.options[idx]}.`);
    return;
  }

  await takaro.variable.variableControllerCreate({
    key: voteKey(poll.id),
    value: JSON.stringify(idx),
    gameServerId,
    moduleId,
    playerId: player.id,
  });
  await player.pm(`Vote counted: ${choice}. ${poll.options[idx]}. You can change it until the poll closes.`);
  if (userConfig.announceVotes) await broadcast(gameServerId, `${player.name} voted in the poll! Use ${prefix}poll to see it.`);
}

await main();
