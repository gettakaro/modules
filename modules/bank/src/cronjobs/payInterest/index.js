import { data, takaro } from '@takaro/helpers';
import {
  listAccountRows,
  parseAccount,
  saveAccount,
  getSetting,
  interestRateFor,
  computeInterest,
  formatAmount,
} from './bank-helpers.js';

const POG_BATCH = 100;

async function main() {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;

  const economyEnabled = await getSetting('economyEnabled', gameServerId);
  if (String(economyEnabled) !== 'true') {
    console.log('bank: economy is disabled on this server, no interest paid');
    return;
  }

  const rows = await listAccountRows(gameServerId, moduleId);
  const eligible = rows
    .map((row) => ({ row, account: parseAccount(row) }))
    .filter(({ row, account }) => row.playerId && account.balance > 0 && account.balance >= config.minimumBalanceForInterest);

  if (eligible.length === 0) {
    console.log(`bank: ${rows.length} accounts, none eligible for interest`);
    return;
  }

  // Fetch the players in batches: the search result carries roles, which the VIP check needs.
  const pogs = new Map();
  for (let i = 0; i < eligible.length; i += POG_BATCH) {
    const ids = eligible.slice(i, i + POG_BATCH).map(({ row }) => row.playerId);
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], playerId: ids },
      limit: POG_BATCH,
    });
    for (const pog of res.data.data) pogs.set(pog.playerId, pog);
  }

  const currencyName = await getSetting('currencyName', gameServerId);
  const now = new Date().toISOString();
  let paidAccounts = 0;
  let paidTotal = 0;

  for (const { row, account } of eligible) {
    const pog = pogs.get(row.playerId);
    const rate = interestRateFor(pog, config.interestRatePercent);
    const interest = computeInterest(account.balance, rate, config);
    if (interest <= 0) continue;

    const updated = {
      ...account,
      balance: account.balance + interest,
      totalInterest: account.totalInterest + interest,
      lastInterest: interest,
      lastInterestAt: now,
    };
    try {
      await saveAccount(row, null, updated);
    } catch (err) {
      console.error(`bank: could not pay interest to ${row.playerId}: ${err}`);
      continue;
    }
    paidAccounts += 1;
    paidTotal += interest;

    if (pog && pog.online && pog.gameId) {
      try {
        await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
          message: `Bank interest: +${formatAmount(interest)} ${currencyName}. Bank balance: ${formatAmount(updated.balance)}.`,
          opts: { recipient: { gameId: pog.gameId } },
        });
      } catch (err) {
        console.warn(`bank: could not notify ${row.playerId}: ${err}`);
      }
    }
  }

  console.log(`bank: paid ${paidTotal} interest to ${paidAccounts} of ${rows.length} accounts`);
}

await main();
