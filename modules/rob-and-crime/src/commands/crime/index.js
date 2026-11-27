import { data, TakaroUserError } from '@takaro/helpers';
import {
  loadContext,
  loadState,
  saveState,
  msLeft,
  formatDuration,
  money,
  randomInt,
  chance,
  pick,
  fill,
  freshPog,
  addCurrency,
  deductCurrency,
  findJailInstallation,
  isJailed,
  sendToJail,
} from './crime-helpers.js';

const DEFAULT_WIN = 'You pulled off a small job and got away with {amount}.';
const DEFAULT_FAIL = 'You got caught and paid a fine of {amount}.';

async function main() {
  const { pog, player, module: mod } = data;
  const cfg = mod.userConfig;
  const { currencyName } = await loadContext();
  const now = Date.now();

  const jail = cfg.crimeJailMinutes > 0 ? await findJailInstallation() : null;
  if (await isJailed(jail, pog.playerId)) {
    throw new TakaroUserError('You are in jail. No crimes until you are released.');
  }

  const entry = await loadState(pog.playerId, player.name);
  const wait = msLeft(entry.state.crimeReadyAt, now);
  if (wait > 0) {
    throw new TakaroUserError(`Lie low for a while. You can do a crime again in ${formatDuration(wait)}.`);
  }

  // The wallet must cover the biggest possible fine, so moving money to a bank first does not make crime risk-free.
  const maxFine = Math.max(cfg.crimeFineMin, cfg.crimeFineMax);
  const wallet = (await freshPog(pog.playerId)).currency ?? 0;
  if (wallet < maxFine) {
    throw new TakaroUserError(
      `You need at least ${money(maxFine, currencyName)} in your wallet to cover a possible fine. You have ${money(wallet, currencyName)}.`,
    );
  }

  // Cooldown first, so two quick commands cannot both roll.
  entry.state.crimeReadyAt = new Date(now + cfg.crimeCooldownMinutes * 60000).toISOString();
  entry.state.crimes += 1;
  await saveState(pog.playerId, entry);

  const failed = chance(cfg.crimeFailChancePercent);
  if (!failed) {
    const reward = randomInt(cfg.crimeRewardMin, cfg.crimeRewardMax);
    await addCurrency(pog.playerId, reward);
    entry.state.crimesWon += 1;
    entry.state.crimeEarned += reward;
    await saveState(pog.playerId, entry);
    await pog.pm(fill(pick(cfg.crimeWinTexts, DEFAULT_WIN), { amount: money(reward, currencyName), player: player.name }));
  } else {
    const fine = randomInt(cfg.crimeFineMin, cfg.crimeFineMax);
    await deductCurrency(pog.playerId, fine);
    entry.state.crimeFines += fine;
    await saveState(pog.playerId, entry);
    await pog.pm(fill(pick(cfg.crimeFailTexts, DEFAULT_FAIL), { amount: money(fine, currencyName), player: player.name }));
    if (jail) {
      const result = await sendToJail(jail, pog, player.name, cfg.crimeJailMinutes, 'Caught doing a crime');
      if (result === 'jailed') {
        await pog.pm(`The guards take you to jail for ${formatDuration(cfg.crimeJailMinutes * 60000)}.`);
      } else {
        console.log(`rob-and-crime: crime jail skipped (${result})`);
      }
    }
  }

  if (cfg.crimeCooldownMinutes > 0) {
    await pog.pm(`Next crime in ${formatDuration(cfg.crimeCooldownMinutes * 60000)}.`);
  }
}

await main();
