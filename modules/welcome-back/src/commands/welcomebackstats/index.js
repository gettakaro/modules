import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';
import { DAY_MS, MAX_WEEKS, STATS_KEY, findVariable, getSetting, parseJson, weekStart } from './welcome-back-helpers.js';

async function main() {
  const { gameServerId, pog, arguments: args, module: mod } = data;

  if (!checkPermission(pog, 'WELCOME_BACK_STATS')) {
    throw new TakaroUserError('You do not have permission to view welcome-back stats.');
  }

  const weeks = Math.round(Number(args.weeks));
  if (!Number.isFinite(weeks) || weeks < 1 || weeks > MAX_WEEKS) {
    throw new TakaroUserError(`Weeks must be a number from 1 to ${MAX_WEEKS}.`);
  }

  const stats = parseJson(await findVariable(STATS_KEY, gameServerId, mod.moduleId), {});
  const currencyName = await getSetting('currencyName', gameServerId, 'coins');

  const nowMs = Date.now();
  const lines = [];
  let totalReturns = 0;
  for (let i = 0; i < weeks; i++) {
    const week = weekStart(nowMs - i * 7 * DAY_MS);
    const entry = stats[week] || { returns: 0, rewarded: 0, currency: 0 };
    totalReturns += entry.returns;
    const label = i === 0 ? `${week} (this week)` : week;
    lines.push(`${label}: ${entry.returns} returned, ${entry.rewarded} rewarded, ${entry.currency} ${currencyName}`);
  }

  await pog.pm(`Welcome-back stats, last ${weeks} week(s) (${totalReturns} returns):`);
  // One PM per line keeps every line readable in small game chat boxes.
  for (const line of lines) {
    await pog.pm(line);
  }
}

await main();
