import { data, takaro, TakaroUserError, checkPermission } from '@takaro/helpers';
import { listAccountRows, parseAccount, getSetting, formatAmount } from './bank-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod } = data;

  if (!checkPermission(pog, 'BANK_MANAGE')) {
    throw new TakaroUserError('You do not have permission to see bank stats.');
  }

  const currencyName = await getSetting('currencyName', gameServerId);
  const accounts = (await listAccountRows(gameServerId, mod.moduleId))
    .map((row) => ({ row, account: parseAccount(row) }))
    .filter(({ account }) => account.balance > 0);

  if (accounts.length === 0) {
    await pog.pm('Bank stats: nobody has money in the bank yet.');
    return;
  }

  const totalHeld = accounts.reduce((sum, { account }) => sum + account.balance, 0);
  const totalInterest = accounts.reduce((sum, { account }) => sum + account.totalInterest, 0);
  const earning = accounts.filter(({ account }) => account.balance >= mod.userConfig.minimumBalanceForInterest).length;

  await pog.pm(
    `Bank stats: ${accounts.length} accounts hold ${formatAmount(totalHeld)} ${currencyName}. ${earning} earn interest. Interest paid so far: ${formatAmount(totalInterest)}.`,
  );

  const top = accounts.sort((a, b) => b.account.balance - a.account.balance).slice(0, mod.userConfig.topSaversCount);
  await pog.pm(`Top ${top.length} savers:`);
  for (let i = 0; i < top.length; i++) {
    const { row, account } = top[i];
    let name = account.name;
    if (!name) {
      try {
        name = (await takaro.player.playerControllerGetOne(row.playerId)).data.data.name;
      } catch {
        name = 'Unknown player';
      }
    }
    await pog.pm(`${i + 1}. ${name}: ${formatAmount(account.balance)} ${currencyName}`);
  }
}

await main();
