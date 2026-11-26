import { data } from '@takaro/helpers';
import { readConfig, getMarketRow, parseMarket, currentPrice, lastChangePct, formatAmount, formatPct, requireEconomy } from './stx-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod } = data;
  const cfg = readConfig(mod.userConfig);
  const { prefix, currency } = await requireEconomy(gameServerId);
  const market = parseMarket(await getMarketRow(gameServerId, mod.moduleId));

  if (cfg.stocks.length === 0) {
    await pog.pm('No stocks are listed right now.');
    return;
  }
  await pog.pm(`Stock market (prices in ${currency}):`);
  for (const stock of cfg.stocks) {
    const price = currentPrice(stock, market, cfg);
    await pog.pm(`${stock.id} ${stock.name}: ${formatAmount(price)} (${formatPct(lastChangePct(stock.id, market))})`);
  }
  await pog.pm(`Use ${prefix}stock <ticker>, ${prefix}buy <ticker> <shares>, ${prefix}sell <ticker> <shares|all>, ${prefix}portfolio.`);
}

await main();
