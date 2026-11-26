import { data } from '@takaro/helpers';
import {
  readConfig, getMarketRow, parseMarket, findStock, getPortfolioRow, parsePortfolio, formatAmount, formatMinutes,
  signed, requireEconomy,
} from './stx-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod } = data;
  const cfg = readConfig(mod.userConfig);
  const { prefix, currency } = await requireEconomy(gameServerId);
  const market = parseMarket(await getMarketRow(gameServerId, mod.moduleId));
  const portfolio = parsePortfolio(await getPortfolioRow(gameServerId, mod.moduleId, pog.playerId));

  const ids = Object.keys(portfolio.holdings).sort();
  if (ids.length === 0) {
    await pog.pm(`You own no shares. See ${prefix}market and buy with ${prefix}buy <ticker> <shares>.`);
    if (portfolio.trades > 0) {
      await pog.pm(`Realized profit so far: ${signed(portfolio.realized)} ${currency}. Fees paid: ${formatAmount(portfolio.feesPaid)}.`);
    }
    return;
  }

  let totalValue = 0;
  let totalCost = 0;
  await pog.pm(`Your portfolio (${currency}):`);
  const now = Date.now();
  for (const id of ids) {
    const h = portfolio.holdings[id];
    const stock = findStock(id, cfg, market);
    const price = stock ? stock.price : 0;
    const value = price * h.shares;
    totalValue += value;
    totalCost += h.cost;
    const notes = [];
    if (cfg.sellLockMinutes > 0 && h.lastBuyAt) {
      const left = Date.parse(h.lastBuyAt) + cfg.sellLockMinutes * 60000 - now;
      if (left > 0) notes.push(`sell in ${formatMinutes(left)}`);
    }
    if (cfg.holdStreakDays > 0 && h.holdSince) {
      const days = (now - Date.parse(h.holdSince)) / 86400000;
      if (days >= cfg.holdStreakDays) notes.push('hold bonus');
      else notes.push(`hold bonus in ${Math.ceil(cfg.holdStreakDays - days)}d`);
    }
    if (stock && stock.delisted) notes.push('delisted');
    const noteText = notes.length ? ` [${notes.join(', ')}]` : '';
    await pog.pm(`${id}: ${formatAmount(h.shares)} x ${formatAmount(price)} = ${formatAmount(value)} (${signed(value - h.cost)})${noteText}`);
  }
  await pog.pm(`Total value ${formatAmount(totalValue)}, paid ${formatAmount(totalCost)}, open profit ${signed(totalValue - totalCost)}.`);
  await pog.pm(`Realized profit ${signed(portfolio.realized)}. Fees paid ${formatAmount(portfolio.feesPaid)}. Fees fund the dividends.`);
}

await main();
