import { data } from '@takaro/helpers';
import {
  textContext,
  dateProblem,
  localClock,
  phaseOf,
  formatDate,
  getState,
  saveState,
  getSignups,
  getGifts,
  broadcast,
  pmGameId,
  onlinePlayers,
  reminderLine,
  pairNow,
  revealNow,
} from './santa-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  const problem = dateProblem(config);
  if (problem) {
    console.log(`secret-santa: config problem, doing nothing: ${problem}`);
    return;
  }

  const clock = localClock(config);
  const { row, state } = await getState(gameServerId, moduleId, clock.season);
  const phase = phaseOf(config, clock, state);
  const ctx = await textContext(gameServerId);
  const reminderDue = clock.hour >= (Number(config.reminderHour) || 0);

  if (phase === 'pair-due') {
    await pairNow(gameServerId, mod, clock, ctx);
    return;
  }
  if (phase === 'reveal-due') {
    await revealNow(gameServerId, mod, clock, ctx);
    return;
  }

  if (phase === 'signup' && config.dailySignupBroadcast && reminderDue && state.lastSignupDay !== clock.today) {
    await saveState(gameServerId, moduleId, clock.season, row, { ...state, lastSignupDay: clock.today });
    const signups = await getSignups(gameServerId, moduleId, clock.season);
    await broadcast(
      gameServerId,
      `Secret Santa sign-up is open until ${formatDate(config.signupEnd)}! Type ${ctx.prefix}santa join to take part (${signups.length} signed up).`,
    );
    return;
  }

  if (phase === 'gifting' && config.dailyReminders && reminderDue && state.lastReminderDay !== clock.today) {
    await saveState(gameServerId, moduleId, clock.season, row, { ...state, lastReminderDay: clock.today });
    const gifts = await getGifts(gameServerId, moduleId, clock.season);
    const online = await onlinePlayers(gameServerId);
    let reminded = 0;
    for (const pair of state.pairs) {
      if (gifts.has(pair.giver)) continue;
      const gameId = online.get(pair.giver);
      if (!gameId) continue;
      await pmGameId(gameServerId, gameId, reminderLine(config, ctx, clock, pair.receiverName));
      reminded++;
    }
    console.log(`secret-santa: reminded ${reminded} online Santas without a gift`);
  }
}

await main();
