import { data, takaro, TakaroUserError, nextCronJobRun } from '@takaro/helpers';
import {
  getAccountRow,
  saveAccount,
  parseAccount,
  getSetting,
  formatAmount,
  formatDuration,
  formatRate,
  interestRateFor,
  computeInterest,
} from './bank-helpers.js';

function parseAmount(raw, usage) {
  const text = String(raw ?? '').trim().toLowerCase().replace(/,/g, '');
  if (text === 'all' || text === 'max') return 'all';
  if (!/^\d+$/.test(text)) throw new TakaroUserError(usage);
  const amount = Number(text);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new TakaroUserError(usage);
  return amount;
}

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;
  const action = String(args.action || 'balance').trim().toLowerCase();

  const [prefix, currencyName, economyEnabled] = await Promise.all([
    getSetting('commandPrefix', gameServerId),
    getSetting('currencyName', gameServerId),
    getSetting('economyEnabled', gameServerId),
  ]);

  const usageAll = `Usage: ${prefix}bank | ${prefix}bank deposit <amount|all> | ${prefix}bank withdraw <amount|all>`;

  if (String(economyEnabled) !== 'true') {
    throw new TakaroUserError('The bank is closed: the economy is not enabled on this server.');
  }

  const row = await getAccountRow(gameServerId, moduleId, pog.playerId);
  const account = parseAccount(row);
  const scope = { gameServerId, moduleId, playerId: pog.playerId };
  const wallet = Math.floor(Number(pog.currency) || 0);

  if (action === 'balance' || action === 'info' || action === 'status') {
    const baseRate = config.interestRatePercent;
    const rate = interestRateFor(pog, baseRate);
    const lines = [`Bank: ${formatAmount(account.balance)} ${currencyName} | Wallet: ${formatAmount(wallet)} ${currencyName}`];

    if (rate <= 0) {
      lines.push('This bank does not pay interest right now.');
    } else {
      const cron = mod.systemConfig?.cronJobs?.payInterest;
      let when = '';
      if (cron && cron.enabled !== false && cron.temporalValue) {
        const next = nextCronJobRun(cron.temporalValue);
        if (next) when = ` in ${formatDuration(new Date(next).getTime() - Date.now())}`;
      }
      const rateText = rate > baseRate ? `${formatRate(rate)} VIP rate` : formatRate(rate);
      const interest = computeInterest(account.balance, rate, config);
      if (account.balance < config.minimumBalanceForInterest) {
        lines.push(
          `Interest: ${rateText}. Keep at least ${formatAmount(config.minimumBalanceForInterest)} ${currencyName} in the bank to earn it.`,
        );
      } else if (interest > 0) {
        lines.push(`Next interest: +${formatAmount(interest)} ${currencyName}${when} (${rateText}).`);
      } else {
        lines.push(`Interest: ${rateText}. Your balance is too small or at the bank limit to earn more.`);
      }
    }

    if (account.lastInterest > 0) {
      lines.push(`Last interest: +${formatAmount(account.lastInterest)} ${currencyName}. Total earned: ${formatAmount(account.totalInterest)}.`);
    }
    lines.push(`Use ${prefix}bank deposit <amount|all> or ${prefix}bank withdraw <amount|all>.`);

    for (const line of lines) {
      await pog.pm(line);
    }
    return;
  }

  if (action === 'deposit' || action === 'd') {
    const usage = `Usage: ${prefix}bank deposit <amount|all>. The amount must be a whole number above 0.`;
    let amount = parseAmount(args.amount, usage);
    const isAll = amount === 'all';
    if (isAll) amount = wallet;

    if (config.maxBankBalance > 0) {
      const room = config.maxBankBalance - account.balance;
      if (room <= 0) {
        throw new TakaroUserError(`Your bank is full (limit ${formatAmount(config.maxBankBalance)} ${currencyName}).`);
      }
      if (isAll) {
        amount = Math.min(amount, room);
      } else if (amount > room) {
        throw new TakaroUserError(
          `You can deposit at most ${formatAmount(room)} more ${currencyName} (bank limit ${formatAmount(config.maxBankBalance)}).`,
        );
      }
    }

    if (amount < 1) throw new TakaroUserError(`You have no ${currencyName} in your wallet to deposit.`);
    if (amount > wallet) {
      throw new TakaroUserError(`You only have ${formatAmount(wallet)} ${currencyName} in your wallet.`);
    }

    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, pog.playerId, {
        currency: amount,
        reason: 'Bank deposit',
      });
    } catch (err) {
      console.error(`bank: deduct failed: ${err}`);
      throw new TakaroUserError(`Could not take ${formatAmount(amount)} ${currencyName} from your wallet. Do you have enough?`);
    }

    const updated = { ...account, balance: account.balance + amount, name: player.name };
    try {
      await saveAccount(row, scope, updated);
    } catch (err) {
      console.error(`bank: saving deposit failed, refunding: ${err}`);
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, pog.playerId, {
        currency: amount,
        reason: 'Bank deposit refund',
      });
      throw new TakaroUserError('The bank could not save your deposit. Your currency was returned.');
    }

    await pog.pm(
      `Deposited ${formatAmount(amount)} ${currencyName}. Bank: ${formatAmount(updated.balance)} | Wallet: ${formatAmount(wallet - amount)}.`,
    );
    return;
  }

  if (action === 'withdraw' || action === 'w') {
    const usage = `Usage: ${prefix}bank withdraw <amount|all>. The amount must be a whole number above 0.`;
    let amount = parseAmount(args.amount, usage);
    if (amount === 'all') amount = account.balance;

    if (amount < 1) throw new TakaroUserError(`Your bank balance is empty.`);
    if (amount > account.balance) {
      throw new TakaroUserError(`You only have ${formatAmount(account.balance)} ${currencyName} in the bank.`);
    }

    const fee = Math.floor((amount * config.withdrawFeePercent) / 100);
    const payout = amount - fee;
    const updated = { ...account, balance: account.balance - amount, name: player.name };
    const rowId = await saveAccount(row, scope, updated);

    if (payout > 0) {
      try {
        await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, pog.playerId, {
          currency: payout,
          reason: 'Bank withdrawal',
        });
      } catch (err) {
        console.error(`bank: add currency failed, restoring balance: ${err}`);
        await saveAccount({ id: rowId }, scope, { ...account, name: player.name });
        throw new TakaroUserError('The bank could not pay out right now. Your bank balance was not changed.');
      }
    }

    const feeText = fee > 0 ? ` (fee ${formatAmount(fee)})` : '';
    await pog.pm(
      `Withdrew ${formatAmount(payout)} ${currencyName}${feeText}. Bank: ${formatAmount(updated.balance)} | Wallet: ${formatAmount(wallet + payout)}.`,
    );
    return;
  }

  throw new TakaroUserError(usageAll);
}

await main();
