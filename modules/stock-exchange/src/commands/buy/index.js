import { data, takaro, TakaroUserError } from '@takaro/helpers';
import {
  readConfig, getMarketRow, parseMarket, findStock, getPortfolioRow, parsePortfolio, saveVar, feeFor, maxSharesFor,
  parseShares, withTradeLock, formatAmount, formatMinutes, requireEconomy, PORTFOLIO_KEY,
} from './stx-helpers.js';

async function main() {
  const { pog, player, gameServerId, arguments: args, module: mod } = data;
  const moduleId = mod.moduleId;
  const cfg = readConfig(mod.userConfig);
  const { prefix, currency } = await requireEconomy(gameServerId);
  const usage = `Usage: ${prefix}buy <ticker> <shares>. Example: ${prefix}buy ${cfg.stocks[0] ? cfg.stocks[0].id : 'DEF'} 5`;

  const market = parseMarket(await getMarketRow(gameServerId, moduleId));
  const stock = findStock(args.ticker, cfg, market);
  if (!stock) throw new TakaroUserError(usage);
  if (stock.delisted) throw new TakaroUserError(`${stock.id} is no longer listed. You can only sell it.`);
  const shares = parseShares(args.amount);
  if (shares === null || shares === 'all') throw new TakaroUserError(usage);

  await withTradeLock(gameServerId, moduleId, pog.playerId, async () => {
    const row = await getPortfolioRow(gameServerId, moduleId, pog.playerId);
    const portfolio = parsePortfolio(row);
    const held = portfolio.holdings[stock.id] ? portfolio.holdings[stock.id].shares : 0;
    const max = maxSharesFor(cfg, pog);
    if (held + shares > max) {
      throw new TakaroUserError(`You can hold at most ${formatAmount(max)} shares of ${stock.id}. You have ${formatAmount(held)}.`);
    }

    const value = stock.price * shares;
    const fee = feeFor(value, cfg, pog);
    const total = value + fee;
    const wallet = Math.floor(Number(pog.currency) || 0);
    if (total > wallet) {
      throw new TakaroUserError(`That costs ${formatAmount(total)} ${currency} (incl. fee ${formatAmount(fee)}). You have ${formatAmount(wallet)}.`);
    }

    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, pog.playerId, {
        currency: total,
        reason: `Stock buy ${shares} ${stock.id}`,
      });
    } catch (err) {
      console.error(`stock-exchange: deduct failed: ${err}`);
      throw new TakaroUserError(`Could not take ${formatAmount(total)} ${currency}. Do you have enough?`);
    }

    const now = new Date().toISOString();
    const prev = portfolio.holdings[stock.id];
    portfolio.holdings[stock.id] = {
      shares: held + shares,
      cost: (prev ? prev.cost : 0) + total,
      holdSince: prev && prev.holdSince ? prev.holdSince : now,
      lastBuyAt: now,
    };
    portfolio.feesPaid += fee;
    portfolio.trades += 1;
    portfolio.name = player.name;
    try {
      await saveVar(row, { gameServerId, moduleId, playerId: pog.playerId }, PORTFOLIO_KEY, portfolio);
    } catch (err) {
      console.error(`stock-exchange: saving buy failed, refunding: ${err}`);
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, pog.playerId, {
        currency: total,
        reason: 'Stock buy refund',
      });
      throw new TakaroUserError('The market could not save your trade. Your currency was returned.');
    }

    await pog.pm(`Bought ${formatAmount(shares)} ${stock.id} at ${formatAmount(stock.price)} for ${formatAmount(value)} + fee ${formatAmount(fee)} = ${formatAmount(total)} ${currency}.`);
    const lockText = cfg.sellLockMinutes > 0 ? ` You can sell them in ${formatMinutes(cfg.sellLockMinutes * 60000)}.` : '';
    await pog.pm(`You now hold ${formatAmount(held + shares)} ${stock.id}.${lockText}`);
  });
}

await main();
