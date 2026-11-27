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
  freshPog,
  playerName,
  isImmune,
  addCurrency,
  deductCurrency,
  pmTo,
  broadcast,
  findJailInstallation,
  isJailed,
  sendToJail,
} from './crime-helpers.js';

async function main() {
  const { pog, player, module: mod, arguments: args } = data;
  const cfg = mod.userConfig;
  const { prefix, currencyName } = await loadContext();
  const now = Date.now();

  const target = args.target;
  if (!target || !target.playerId) {
    throw new TakaroUserError(`Usage: ${prefix}rob <player>`);
  }
  if (target.playerId === pog.playerId) {
    throw new TakaroUserError('You cannot rob yourself.');
  }

  const jail = cfg.robJailMinutes > 0 ? await findJailInstallation() : null;
  if (await isJailed(jail, pog.playerId)) {
    throw new TakaroUserError('You are in jail. No robberies until you are released.');
  }

  const [victimPog, victimName] = await Promise.all([freshPog(target.playerId), playerName(target.playerId)]);
  if (!victimPog || !victimPog.online) {
    throw new TakaroUserError(`${victimName} is not online. You can only rob players who are online.`);
  }
  if (isImmune(victimPog)) {
    throw new TakaroUserError(`${victimName} is protected and cannot be robbed.`);
  }

  const robber = await loadState(pog.playerId, player.name);
  const wait = msLeft(robber.state.robReadyAt, now);
  if (wait > 0) {
    throw new TakaroUserError(`You are still laying low. You can rob again in ${formatDuration(wait)}.`);
  }

  const victim = await loadState(target.playerId, victimName);
  const shielded = msLeft(victim.state.protectedUntil, now);
  if (shielded > 0) {
    throw new TakaroUserError(`${victimName} was robbed recently. Try again in ${formatDuration(shielded)}.`);
  }

  // Only the wallet (Takaro currency) can be robbed. Savings in a bank module are never touched.
  const victimWallet = victimPog.currency ?? 0;
  if (victimWallet < cfg.minVictimBalance) {
    throw new TakaroUserError(`${victimName} has too little in their wallet to be worth robbing.`);
  }

  const pctMin = Math.min(cfg.robPercentMin, cfg.robPercentMax);
  const pctMax = Math.max(cfg.robPercentMin, cfg.robPercentMax);
  const cap = (n) => (cfg.robMaxAmount > 0 ? Math.min(cfg.robMaxAmount, n) : n);
  const maxLoot = cap(Math.floor((victimWallet * pctMax) / 100));
  const fine = Math.max(cfg.robFineMin, Math.floor((maxLoot * cfg.robFinePercent) / 100));

  const robberWallet = (await freshPog(pog.playerId)).currency ?? 0;
  if (robberWallet < fine) {
    throw new TakaroUserError(
      `You need at least ${money(fine, currencyName)} in your wallet to pay the fine if you get caught. You have ${money(robberWallet, currencyName)}.`,
    );
  }

  // Cooldown first, so two quick commands cannot both roll.
  robber.state.robReadyAt = new Date(now + cfg.robCooldownMinutes * 60000).toISOString();
  robber.state.robs += 1;
  await saveState(pog.playerId, robber);

  if (!chance(cfg.robFailChancePercent)) {
    const pct = pctMin + Math.random() * (pctMax - pctMin);
    const wanted = Math.max(1, cap(Math.floor((victimWallet * pct) / 100)));
    // Re-read the wallet: it may have changed since the checks.
    const nowWallet = (await freshPog(target.playerId)).currency ?? 0;
    const loot = Math.min(wanted, nowWallet);
    if (loot <= 0) {
      await saveState(pog.playerId, robber);
      await pog.pm(`${victimName} had empty pockets. You got nothing.`);
      return;
    }
    await deductCurrency(target.playerId, loot);
    await addCurrency(pog.playerId, loot);

    robber.state.robsWon += 1;
    robber.state.stolen += loot;
    await saveState(pog.playerId, robber);
    victim.state.timesRobbed += 1;
    victim.state.lostToRobbers += loot;
    if (cfg.victimProtectionMinutes > 0) {
      victim.state.protectedUntil = new Date(now + cfg.victimProtectionMinutes * 60000).toISOString();
    }
    await saveState(target.playerId, victim);

    await pog.pm(`You robbed ${victimName} and got away with ${money(loot, currencyName)}.`);
    await pmTo(victimPog.gameId, `${player.name} robbed you and took ${money(loot, currencyName)} from your wallet.`);
    if (cfg.announce) {
      await broadcast(`${player.name} robbed ${victimName} for ${money(loot, currencyName)}.`);
    }
  } else {
    const paid = Math.min(fine, (await freshPog(pog.playerId)).currency ?? 0);
    if (paid > 0) {
      await deductCurrency(pog.playerId, paid);
      await addCurrency(target.playerId, paid);
    }
    robber.state.robFines += paid;
    await saveState(pog.playerId, robber);
    victim.state.finesReceived += paid;
    await saveState(target.playerId, victim);

    await pog.pm(`${victimName} caught you. You paid ${victimName} a fine of ${money(paid, currencyName)}.`);
    await pmTo(victimPog.gameId, `${player.name} tried to rob you and got caught. You get ${money(paid, currencyName)} as compensation.`);
    if (cfg.announce) {
      await broadcast(`${player.name} got caught trying to rob ${victimName}.`);
    }
    if (jail) {
      const result = await sendToJail(jail, pog, player.name, cfg.robJailMinutes, `Caught robbing ${victimName}`);
      if (result === 'jailed') {
        await pog.pm(`The guards take you to jail for ${formatDuration(cfg.robJailMinutes * 60000)}.`);
      } else {
        console.log(`rob-and-crime: rob jail skipped (${result})`);
      }
    }
  }
}

await main();
