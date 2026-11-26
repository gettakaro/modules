import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import {
  textContext,
  dateProblem,
  localClock,
  phaseOf,
  formatDate,
  giftRange,
  getState,
  getSignups,
  findSignup,
  findGift,
  getGifts,
  signupKey,
  giftKey,
  broadcast,
  pmGameId,
  onlinePlayers,
  assignmentLines,
  revealLinesFor,
  pairNow,
  revealNow,
  resetSeason,
} from './santa-helpers.js';

const MAX_NOTE_LENGTH = 100;

/**
 * { action, rest } from the raw chat line: Takaro gives text arguments only their first word,
 * and the gift note needs the whole sentence. Falls back to the parsed arguments.
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

function requireManage(pog) {
  if (!checkPermission(pog, 'SECRET_SANTA_MANAGE')) {
    throw new TakaroUserError('You do not have permission to manage Secret Santa.');
  }
}

function count(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

async function showStatus(c) {
  const { config, ctx, clock, state, phase, player, gameServerId, moduleId } = c;
  const pm = (m) => player.pm(m);

  if (phase === 'before') {
    await pm(`Secret Santa sign-up opens on ${formatDate(config.signupStart)}.`);
    return;
  }
  if (phase === 'cancelled') {
    await pm('Secret Santa was cancelled this year: not enough players signed up.');
    return;
  }
  if (phase === 'signup' || phase === 'pair-due') {
    const signups = await getSignups(gameServerId, moduleId, clock.season);
    const joined = signups.some((s) => s.playerId === player.id);
    if (phase === 'pair-due') {
      await pm(`Secret Santa sign-up is closed. The names are drawn soon (${count(signups.length, 'player')}).`);
    } else if (joined) {
      await pm(`You are signed up for Secret Santa (${count(signups.length, 'player')} so far). Names are drawn after ${formatDate(config.signupEnd)}.`);
    } else {
      await pm(`Secret Santa sign-up is open until ${formatDate(config.signupEnd)}. Type ${ctx.prefix}santa join to take part (${count(signups.length, 'player')} so far).`);
    }
    return;
  }
  if (phase === 'done') {
    const mine = (state.results ?? []).filter((r) => r.receiver === player.id || r.giver === player.id);
    if (mine.length === 0) {
      await pm('Secret Santa is over for this year.');
      return;
    }
    for (const r of mine) {
      if (r.receiver === player.id) for (const line of revealLinesFor(r, ctx)) await pm(line);
    }
    for (const r of mine) {
      if (r.giver === player.id) {
        await pm(r.fromServer ? `You were the Secret Santa of ${r.receiverName} but sent no gift.` : `You were the Secret Santa of ${r.receiverName} and gave ${r.amount} ${ctx.currency}.`);
      }
    }
    return;
  }

  // gifting | closed | reveal-due
  const pair = state.pairs.find((p) => p.giver === player.id);
  if (!pair) {
    await pm(`Secret Santa names are drawn, sign-up is closed. The reveal is on ${formatDate(config.revealDate)}.`);
    return;
  }
  const [gift, incoming] = [await findGift(gameServerId, moduleId, clock.season, player.id), state.pairs.find((p) => p.receiver === player.id)];
  await pm(`You are the Secret Santa of ${pair.receiverName}.`);
  if (gift) {
    await pm(`You sent ${gift.amount} ${ctx.currency}. It opens on ${formatDate(config.revealDate)}.`);
  } else if (phase === 'gifting') {
    await pm(`Send your gift with ${ctx.prefix}santa gift <amount> [note] by ${formatDate(config.giftDeadline)} (${giftRange(config, ctx.currency)}).`);
  } else {
    await pm('The gift deadline has passed.');
  }
  if (incoming) {
    const theirs = await findGift(gameServerId, moduleId, clock.season, incoming.giver);
    if (theirs) await pm(`Your Secret Santa sent you a gift! It opens on ${formatDate(config.revealDate)}.`);
  }
}

async function join(c) {
  const { config, ctx, clock, phase, player, pog, gameServerId, moduleId } = c;
  if (phase === 'before') throw new TakaroUserError(`Secret Santa sign-up opens on ${formatDate(config.signupStart)}.`);
  if (phase !== 'signup') throw new TakaroUserError('Secret Santa sign-up is closed for this year.');
  try {
    await takaro.variable.variableControllerCreate({
      key: signupKey(clock.season),
      value: JSON.stringify({ name: player.name, gameId: pog.gameId, at: new Date().toISOString() }),
      gameServerId,
      moduleId,
      playerId: player.id,
    });
  } catch {
    throw new TakaroUserError('You are already signed up for Secret Santa.');
  }
  const total = (await getSignups(gameServerId, moduleId, clock.season)).length;
  await player.pm(`You joined Secret Santa! Names are drawn after ${formatDate(config.signupEnd)}. Leave with ${ctx.prefix}santa leave.`);
  if (config.announceJoins) {
    await broadcast(gameServerId, `${player.name} joined Secret Santa (${count(total, 'player')}). Type ${ctx.prefix}santa join to take part.`);
  }
}

async function leave(c) {
  const { phase, player, clock, gameServerId, moduleId } = c;
  if (phase !== 'signup') throw new TakaroUserError('You can only leave Secret Santa before the names are drawn.');
  const row = await findSignup(gameServerId, moduleId, clock.season, player.id);
  if (!row) throw new TakaroUserError('You are not signed up for Secret Santa.');
  await takaro.variable.variableControllerDelete(row.id);
  await player.pm('You left Secret Santa.');
}

async function gift(c) {
  const { config, ctx, clock, state, phase, player, rest, gameServerId, moduleId } = c;
  if (phase === 'closed' || phase === 'reveal-due' || phase === 'done') throw new TakaroUserError('The Secret Santa gift deadline has passed.');
  if (phase !== 'gifting') throw new TakaroUserError('Secret Santa names are not drawn yet. You can send a gift after the draw.');
  const pair = state.pairs.find((p) => p.giver === player.id);
  if (!pair) throw new TakaroUserError('You are not taking part in Secret Santa this year.');

  const usage = `Usage: ${ctx.prefix}santa gift <amount> [note]`;
  const m = rest.match(/^(\d+)(?:\s+([\s\S]*))?$/);
  if (!m) throw new TakaroUserError(usage);
  const amount = parseInt(m[1], 10);
  const min = Number(config.minGift) || 0;
  const max = Number(config.maxGift) || 0;
  if (amount < Math.max(1, min) || (max > 0 && amount > max)) {
    throw new TakaroUserError(`Your gift must be ${giftRange(config, ctx.currency)}.`);
  }
  const note = (m[2] ?? '').replace(/\s+/g, ' ').trim();
  if (note.length > MAX_NOTE_LENGTH) throw new TakaroUserError(`The note can be at most ${MAX_NOTE_LENGTH} characters.`);

  // Create the gift first: the unique index makes a second, parallel gift fail before any money moves.
  let created;
  try {
    const res = await takaro.variable.variableControllerCreate({
      key: giftKey(clock.season),
      value: JSON.stringify({ amount, note, receiver: pair.receiver, at: new Date().toISOString() }),
      gameServerId,
      moduleId,
      playerId: player.id,
    });
    created = res.data.data;
  } catch {
    throw new TakaroUserError('You already sent your Secret Santa gift.');
  }
  try {
    await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, player.id, { currency: amount });
  } catch (err) {
    console.log(`secret-santa: deduct ${amount} from ${player.name} failed: ${err}`);
    await takaro.variable.variableControllerDelete(created.id);
    throw new TakaroUserError(`You do not have ${amount} ${ctx.currency}.`);
  }

  await player.pm(`Gift of ${amount} ${ctx.currency} sent to ${pair.receiverName}. It stays secret until ${formatDate(config.revealDate)}.`);
  const online = await onlinePlayers(gameServerId);
  const receiverGameId = online.get(pair.receiver);
  if (receiverGameId) {
    await pmGameId(gameServerId, receiverGameId, `Your Secret Santa sent you a gift! It opens on ${formatDate(config.revealDate)}.`);
  }
}

async function adminStatus(c) {
  const { config, clock, state, phase, player, gameServerId, moduleId, ctx } = c;
  const pm = (m) => player.pm(m);
  await pm(`Secret Santa ${clock.season}: ${phase}. Sign-up ${formatDate(config.signupStart)} to ${formatDate(config.signupEnd)}, gifts by ${formatDate(config.giftDeadline)}, reveal ${formatDate(config.revealDate)}.`);
  if (!state.pairs) {
    const signups = await getSignups(gameServerId, moduleId, clock.season);
    await pm(`Signed up: ${signups.length}${signups.length ? ` (${signups.map((s) => s.name).join(', ')})` : ''}.`);
    return;
  }
  if (state.results) {
    const sent = state.results.filter((r) => !r.fromServer).length;
    await pm(`Revealed: ${sent} of ${state.results.length} Santas sent a gift.`);
    return;
  }
  const gifts = await getGifts(gameServerId, moduleId, clock.season);
  const missing = state.pairs.filter((p) => !gifts.has(p.giver)).map((p) => p.giverName);
  const held = [...gifts.values()].reduce((sum, g) => sum + (Number(g.amount) || 0), 0);
  await pm(`Pairs: ${state.pairs.length}. Gifts sent: ${gifts.size} (${held} ${ctx.currency} held).`);
  if (missing.length) await pm(`No gift yet: ${missing.join(', ')}.`);
}

async function main() {
  const { player, pog, gameServerId, arguments: args, chatMessage, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;
  const ctx = await textContext(gameServerId);
  const { action, rest } = parseInput(args, chatMessage, ctx.prefix);

  const problem = dateProblem(config);
  if (problem) {
    console.log(`secret-santa: config problem: ${problem}`);
    throw new TakaroUserError('Secret Santa dates are set up wrong. Ask an admin to check the module config.');
  }

  const clock = localClock(config);
  const { state } = await getState(gameServerId, moduleId, clock.season);
  const phase = phaseOf(config, clock, state);
  const c = { config, ctx, clock, state, phase, player, pog, rest, gameServerId, moduleId };

  switch (action) {
    case '':
    case 'show':
    case 'status':
      return showStatus(c);
    case 'join':
      return join(c);
    case 'leave':
      return leave(c);
    case 'gift':
    case 'send':
      return gift(c);
    case 'admin':
      requireManage(pog);
      return adminStatus(c);
    case 'pair':
    case 'draw': {
      requireManage(pog);
      if (state.pairs) throw new TakaroUserError('The names are already drawn.');
      if (phase === 'done' || phase === 'cancelled') throw new TakaroUserError(`Secret Santa is ${phase === 'done' ? 'over' : 'cancelled'} this year. Use ${ctx.prefix}santa reset to start again.`);
      const res = await pairNow(gameServerId, mod, clock, ctx);
      if (res.state.cancelled) {
        await player.pm(`Not enough players signed up (need ${Math.max(2, Number(config.minParticipants) || 3)}). Secret Santa is cancelled.`);
      } else {
        await player.pm(`Drew ${res.state.pairs.length} Secret Santa pairs.`);
      }
      return;
    }
    case 'reveal': {
      requireManage(pog);
      if (!state.pairs) throw new TakaroUserError('The names are not drawn yet.');
      if (state.revealedAt) throw new TakaroUserError('Secret Santa is already revealed.');
      await revealNow(gameServerId, mod, clock, ctx);
      await player.pm('Secret Santa revealed and gifts paid out.');
      return;
    }
    case 'reset': {
      requireManage(pog);
      const { refunded, deleted } = await resetSeason(gameServerId, mod, clock);
      await player.pm(`Secret Santa ${clock.season} reset: ${deleted} records removed, ${refunded} held gift${refunded === 1 ? '' : 's'} refunded.`);
      await broadcast(gameServerId, 'Secret Santa was reset by an admin.');
      return;
    }
    default:
      throw new TakaroUserError(`Unknown option "${action}". Use ${ctx.prefix}santa, ${ctx.prefix}santa join, ${ctx.prefix}santa leave or ${ctx.prefix}santa gift <amount> [note].`);
  }
}

await main();
