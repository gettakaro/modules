import { data, takaro, TakaroUserError } from '@takaro/helpers';
import {
  readConfig, getMarketRow, parseMarket, findStock, getPortfolioRow, parsePortfolio, saveVar, feeFor, parseShares,
  withTradeLock, formatAmount, formatMinutes, signed, requireEconomy, PORTFOLIO_KEY,
} from './stx-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;
  const moduleId = mod.moduleId;
  const cfg = readConfig(mod.userConfig);
  const { prefix, currency } = await requireEconomy(gameServerId);
  const usage = `Usage: ${prefix}sell <ticker> <shares|all>. See ${prefix}portfolio for what you hold.`;

  const market = parseMarket(await getMarketRow(gameServerId, moduleId));
  const stock = findStock(args.ticker, cfg, market);
  const wanted = parseShares(args.amount);
  if (!stock || wanted === null) throw new TakaroUserError(usage);

  await withTradeLock(gameServerId, moduleId, pog.playerId, async () => {
    const row = await getPortfolioRow(gameServerId, moduleId, pog.playerId);
    const portfolio = parsePortfolio(row);
    const before = JSON.parse(JSON.stringify(portfolio));
    const h = portfolio.holdings[stock.id];
    if (!h) throw new TakaroUserError(`You have no ${stock.id} shares.`);
    const shares = wanted === 'all' ? h.shares : wanted;
    if (shares > h.shares) throw new TakaroUserError(`You only have ${formatAmount(h.shares)} ${stock.id} shares.`);

    if (cfg.sellLockMinutes > 0 && h.lastBuyAt) {
      const left = Date.parse(h.lastBuyAt) + cfg.sellLockMinutes * 60000 - Date.now();
      if (left > 0) throw new TakaroUserError(`You just bought ${stock.id}. You can sell it in ${formatMinutes(left)}.`);
    }

    const value = stock.price * shares;
    const fee = Math.min(value, feeFor(value, cfg, pog));
    const payout = value - fee;
    const costPart = Math.round((h.cost * shares) / h.shares);
    const profit = payout - costPart;

    // Write the portfolio BEFORE paying: a second sell (or a crash) can never pay twice for the same shares.
    if (shares === h.shares) {
      delete portfolio.holdings[stock.id];
    } else {
      portfolio.holdings[stock.id] = { ...h, shares: h.shares - shares, cost: h.cost - costPart };
    }
    portfolio.feesPaid += fee;
    portfolio.realized += profit;
    portfolio.trades += 1;
    portfolio.name = player.name;
    const scope = { gameServerId, moduleId, playerId: pog.playerId };
    const rowId = await saveVar(row, scope, PORTFOLIO_KEY, portfolio);

    if (payout > 0) {
      try {
        await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, pog.playerId, {
          currency: payout,
          reason: `Stock sell ${shares} ${stock.id}`,
        });
      } catch (err) {
        console.error(`stock-exchange: payout failed, restoring shares: ${err}`);
        await saveVar({ id: rowId }, scope, PORTFOLIO_KEY, before);
        throw new TakaroUserError('The market could not pay you right now. Your shares were not sold.');
      }
    }

    await pog.pm(`Sold ${formatAmount(shares)} ${stock.id} at ${formatAmount(stock.price)} for ${formatAmount(value)} - fee ${formatAmount(fee)} = ${formatAmount(payout)} ${currency}.`);
    const left = portfolio.holdings[stock.id] ? portfolio.holdings[stock.id].shares : 0;
    await pog.pm(`Profit on these shares: ${signed(profit)} ${currency}. You still hold ${formatAmount(left)} ${stock.id}.`);
  });
}

await main();
