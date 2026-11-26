import { data } from '@takaro/helpers';
import {
  textContext,
  dateProblem,
  localClock,
  phaseOf,
  formatDate,
  getState,
  findSignup,
  findGift,
  reminderLine,
  tellReveal,
} from './santa-helpers.js';

async function main() {
  const { gameServerId, module: mod, player, pog } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;
  if (!player || dateProblem(config)) return;

  const clock = localClock(config);
  const { state } = await getState(gameServerId, moduleId, clock.season);
  const phase = phaseOf(config, clock, state);
  const ctx = await textContext(gameServerId);

  if (phase === 'done') {
    // Receivers who were offline at the reveal hear about their gift once, on their next join.
    const result = (state.results ?? []).find((r) => r.receiver === player.id);
    if (result) await tellReveal(gameServerId, moduleId, clock.season, result, pog.gameId, ctx);
    return;
  }
  if (!config.remindOnConnect) return;

  if (phase === 'signup') {
    if (await findSignup(gameServerId, moduleId, clock.season, player.id)) return;
    await player.pm(`Secret Santa sign-up is open until ${formatDate(config.signupEnd)}. Type ${ctx.prefix}santa join to take part.`);
    return;
  }
  if (phase === 'gifting') {
    const pair = state.pairs.find((p) => p.giver === player.id);
    if (!pair) return;
    if (await findGift(gameServerId, moduleId, clock.season, player.id)) return;
    await player.pm(reminderLine(config, ctx, clock, pair.receiverName));
  }
}

await main();
