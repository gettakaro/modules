import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import {
  readConfig, getMarketRow, parseMarket, findStock, listPortfolioRows, parsePortfolio, getDividendsRow, parseDividends,
  poolFrom, formatAmount, requireEconomy,
} from './stx-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod } = data;
  if (!checkPermission(pog, 'STOCK_ADMIN')) {
    throw new TakaroUserError('You do not have permission to see market stats.');
  }
  const cfg = readConfig(mod.userConfig);
  const { currency } = await requireEconomy(gameServerId);
  const market = parseMarket(await getMarketRow(gameServerId, mod.moduleId));
  const rows = await listPortfolioRows(gameServerId, mod.moduleId);
  const portfolios = rows.map((r) => ({ playerId: r.playerId, ...parsePortfolio(r) }));
  const dividends = parseDividends(await getDividendsRow(gameServerId, mod.moduleId));
  const { fees, paid, pool } = poolFrom(portfolios, dividends);

  let shares = 0;
  let value = 0;
  const holders = [];
  for (const p of portfolios) {
    let v = 0;
    for (const [id, h] of Object.entries(p.holdings)) {
      const stock = findStock(id, cfg, market);
      shares += h.shares;
      v += (stock ? stock.price : 0) * h.shares;
    }
    value += v;
    if (v > 0) holders.push({ name: p.name ?? 'unknown', value: v });
  }
  holders.sort((a, b) => b.value - a.value);
  const traders = portfolios.filter((p) => p.trades > 0).length;

  await pog.pm(`Market: ${traders} traders, ${holders.length} holders, ${formatAmount(shares)} shares worth ${formatAmount(value)} ${currency}.`);
  await pog.pm(`Fees in ${formatAmount(fees)}. Dividends out ${formatAmount(paid)} in ${dividends.runs} run${dividends.runs === 1 ? '' : 's'}. Fee pool now ${formatAmount(pool)}.`);
  if (holders.length) {
    await pog.pm(`Top holders: ${holders.slice(0, 3).map((h) => `${h.name} ${formatAmount(h.value)}`).join(', ')}.`);
  }
  const l = market.last;
  await pog.pm(
    `Last update #${market.tick}: kills ${l.kills ?? 0}, deaths ${l.deaths ?? 0}, travel ${l.travel ?? 0}, online ${l.players ?? 0}.`,
  );
}

await main();
