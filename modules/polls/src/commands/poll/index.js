import { data, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  getSetting,
  getActivePoll,
  getLastPoll,
  createActivePoll,
  tally,
  findPlayerVote,
  formatResultLines,
  winnerText,
  voteCount,
  formatRemaining,
  broadcast,
  closePoll,
} from './polls-helpers.js';

const MAX_QUESTION_LENGTH = 200;
const MAX_OPTION_LENGTH = 80;

/**
 * Returns { action, rest } from the raw chat line, so the question and options keep their spaces
 * no matter how Takaro splits arguments. Falls back to the parsed arguments.
 */
function parseInput(args, chatMessage, prefix) {
  const raw = typeof chatMessage?.msg === 'string' ? chatMessage.msg.trim() : '';
  if (raw) {
    const body = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    const match = body.trim().match(/^\S+\s*(\S*)\s*([\s\S]*)$/);
    if (match) return { action: match[1].toLowerCase(), rest: match[2].trim() };
  }
  const action = String(args.action ?? '').toLowerCase();
  const details = String(args.details ?? '');
  return { action: action === 'show' ? '' : action, rest: details === '-' ? '' : details.trim() };
}

async function requireManage(pog) {
  if (!checkPermission(pog, 'POLLS_MANAGE')) {
    throw new TakaroUserError('You do not have permission to manage polls.');
  }
}

async function createPoll({ rest, prefix, player, pog, gameServerId, mod }) {
  await requireManage(pog);
  const { maxOptions, maxDurationMinutes } = mod.userConfig;
  const usage = `Usage: ${prefix}poll create <minutes> <question> | <option1> | <option2> | ...`;

  const m = rest.match(/^(\d+)\s+([\s\S]+)$/);
  if (!m) throw new TakaroUserError(usage);
  const minutes = parseInt(m[1], 10);
  if (!(minutes >= 1 && minutes <= maxDurationMinutes)) {
    throw new TakaroUserError(`Duration must be between 1 and ${maxDurationMinutes} minutes.`);
  }

  const parts = m[2].split('|').map((p) => p.trim());
  const question = parts[0];
  const options = parts.slice(1).filter((p) => p.length > 0);
  if (!question) throw new TakaroUserError(`The poll needs a question. ${usage}`);
  if (options.length < 2) throw new TakaroUserError(`A poll needs at least 2 options, separated by |. ${usage}`);
  if (options.length > maxOptions) throw new TakaroUserError(`A poll can have at most ${maxOptions} options.`);
  if (question.length > MAX_QUESTION_LENGTH) throw new TakaroUserError(`The question is too long (max ${MAX_QUESTION_LENGTH} characters).`);
  if (options.some((o) => o.length > MAX_OPTION_LENGTH)) throw new TakaroUserError(`Each option can be at most ${MAX_OPTION_LENGTH} characters.`);

  const existing = await getActivePoll(gameServerId, mod.moduleId);
  if (existing) {
    throw new TakaroUserError(`A poll is already running: "${existing.poll.question}". Close it first with ${prefix}poll close.`);
  }

  const now = Date.now();
  const poll = {
    id: `${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    question,
    options,
    createdBy: player.name,
    createdAt: new Date(now).toISOString(),
    endsAt: new Date(now + minutes * 60000).toISOString(),
  };
  await createActivePoll(gameServerId, mod.moduleId, poll);

  await broadcast(gameServerId, `New poll (${minutes} min): ${question}`);
  for (let i = 0; i < options.length; i++) await broadcast(gameServerId, `${i + 1}. ${options[i]}`);
  await broadcast(gameServerId, `Vote with ${prefix}pollvote <number>. See results with ${prefix}poll.`);
}

async function showPoll({ prefix, player, gameServerId, mod }) {
  const active = await getActivePoll(gameServerId, mod.moduleId);
  if (!active) {
    const last = await getLastPoll(gameServerId, mod.moduleId);
    if (!last) {
      await player.pm('No poll is running right now.');
      return;
    }
    await player.pm(`No poll is running. Last poll: ${last.question}`);
    for (const line of formatResultLines(last.options, last.counts, last.total)) await player.pm(line);
    const winner = winnerText(last.options, last.counts, last.total);
    await player.pm(winner ? `${winner} (${voteCount(last.total)})` : 'Nobody voted.');
    return;
  }

  const { poll } = active;
  const [{ counts, total }, mine] = await Promise.all([
    tally(gameServerId, mod.moduleId, poll),
    findPlayerVote(gameServerId, mod.moduleId, poll.id, player.id),
  ]);
  await player.pm(`Poll: ${poll.question} (${formatRemaining(poll.endsAt)}, ${total} vote${total === 1 ? '' : 's'})`);
  for (const line of formatResultLines(poll.options, counts, total)) await player.pm(line);
  const myIdx = mine ? Number(JSON.parse(mine.value)) : -1;
  await player.pm(
    myIdx >= 0 && myIdx < poll.options.length
      ? `You voted for ${myIdx + 1}. ${poll.options[myIdx]}. Change it with ${prefix}pollvote <number>.`
      : `Vote with ${prefix}pollvote <number>.`,
  );
}

async function main() {
  const { player, pog, gameServerId, arguments: args, chatMessage, module: mod } = data;
  const prefix = await getSetting('commandPrefix', gameServerId, '/');
  const { action, rest } = parseInput(args, chatMessage, prefix);
  const ctx = { rest, prefix, player, pog, gameServerId, mod };

  if (action === '' || action === 'show' || action === 'results') {
    await showPoll(ctx);
  } else if (action === 'create' || action === 'start') {
    await createPoll(ctx);
  } else if (action === 'close' || action === 'end' || action === 'stop') {
    await requireManage(pog);
    const active = await getActivePoll(gameServerId, mod.moduleId);
    if (!active) throw new TakaroUserError('No poll is running.');
    await closePoll(gameServerId, mod, active, 'manual');
  } else {
    throw new TakaroUserError(`Unknown option "${action}". Use ${prefix}poll, ${prefix}poll create or ${prefix}poll close.`);
  }
}

await main();
