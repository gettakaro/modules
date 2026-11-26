import { data, TakaroUserError } from '@takaro/helpers';
import {
  readConfig, getMarketRow, parseMarket, findStock, priceBounds, lastChangePct, getPortfolioRow, parsePortfolio,
  formatAmount, formatPct, requireEconomy, DRIVER_TEXT,
} from './stx-helpers.js';

async function main() {
  const { pog, gameServerId, arguments: args, module: mod } = data;
  const cfg = readConfig(mod.userConfig);
  const { prefix, currency } = await requireEconomy(gameServerId);
  const market = parseMarket(await getMarketRow(gameServerId, mod.moduleId));

  const stock = findStock(args.ticker, cfg, market);
  if (!stock) {
    const list = cfg.stocks.map((s) => s.id).join(', ');
    throw new TakaroUserError(`Usage: ${prefix}stock <ticker>. Tickers: ${list || 'none'}.`);
  }

  await pog.pm(`${stock.id} ${stock.name}: ${formatAmount(stock.price)} ${currency} (${formatPct(lastChangePct(stock.id, market))} last update).`);
  if (stock.delisted) {
    await pog.pm('This stock is no longer listed. You can still sell it at this price, but not buy it.');
  } else {
    const { floor, ceiling } = priceBounds(stock, cfg);
    await pog.pm(`Moves with: ${DRIVER_TEXT[stock.driver]}. Base ${formatAmount(stock.basePrice)}, range ${formatAmount(floor)} to ${formatAmount(ceiling)}.`);
  }
  const history = (market.stocks[stock.id] && Array.isArray(market.stocks[stock.id].history)) ? market.stocks[stock.id].history : [];
  if (history.length > 1) {
    await pog.pm(`Last prices: ${history.slice(-cfg.historyLength).map(formatAmount).join(', ')}`);
  }

  const portfolio = parsePortfolio(await getPortfolioRow(gameServerId, mod.moduleId, pog.playerId));
  const h = portfolio.holdings[stock.id];
  if (h) {
    await pog.pm(`You hold ${formatAmount(h.shares)} shares, worth ${formatAmount(h.shares * stock.price)} ${currency}.`);
  }
  const feeText = cfg.feePercent > 0 || cfg.minFee > 0 ? `Fee ${cfg.feePercent}% per trade (min ${cfg.minFee}).` : 'No trade fee.';
  await pog.pm(feeText);
}

await main();
