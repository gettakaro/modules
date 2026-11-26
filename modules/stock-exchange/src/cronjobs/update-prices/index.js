import { data } from '@takaro/helpers';
import {
  readConfig, getMarketRow, parseMarket, saveVar, takeSignals, countOnline, signalDelta, nextPrice, currentPrice,
  broadcast, getServerTexts, formatAmount, formatPct, DRIVER_TEXT, MARKET_KEY,
} from './stx-helpers.js';

const AVG_WEIGHT = 0.3;

async function main() {
  const { gameServerId, module: mod } = data;
  const moduleId = mod.moduleId;
  const cfg = readConfig(mod.userConfig);
  const { economyEnabled } = await getServerTexts(gameServerId);
  if (!economyEnabled) {
    console.log('stock-exchange: economy disabled, prices not updated');
    return;
  }

  const row = await getMarketRow(gameServerId, moduleId);
  const market = parseMarket(row);
  const signals = await takeSignals(gameServerId, moduleId);
  signals.players = await countOnline(gameServerId);

  const deltas = {};
  const avg = { ...market.avg };
  for (const [signal, value] of Object.entries(signals)) {
    const prevAvg = Number(avg[signal]);
    deltas[signal] = signalDelta(value, Number.isFinite(prevAvg) ? prevAvg : NaN);
    avg[signal] = Number.isFinite(prevAvg) ? prevAvg + AVG_WEIGHT * (value - prevAvg) : value;
  }

  const moves = [];
  const stocks = { ...market.stocks };
  for (const stock of cfg.stocks) {
    const prev = currentPrice(stock, market, cfg);
    const delta = stock.driver === 'random' ? 0 : deltas[stock.driver] ?? 0;
    const { price, changePct, signalPct } = nextPrice(stock, prev, delta, cfg, Math.random());
    const old = stocks[stock.id] && Array.isArray(stocks[stock.id].history) ? stocks[stock.id].history : [prev];
    const history = [...old, price].slice(-Math.max(cfg.historyLength, 2));
    stocks[stock.id] = { name: stock.name, price, prev, changePct: Math.round(changePct * 10) / 10, history };
    moves.push({ stock, price, changePct, signalPct });
  }

  // Prices are saved first; news goes out only after the move, so nobody can trade on it in advance.
  const next = {
    stocks,
    avg,
    last: signals,
    tick: market.tick + 1,
    lastTickAt: new Date().toISOString(),
  };
  await saveVar(row, { gameServerId, moduleId }, MARKET_KEY, next);
  console.log(`stock-exchange: tick ${next.tick} signals ${JSON.stringify(signals)} moves ${moves.map((m) => `${m.stock.id}=${m.price}`).join(' ')}`);

  if (cfg.newsMinMovePercent <= 0 || cfg.maxNewsLines <= 0) return;
  const news = moves
    .filter((m) => Math.abs(m.changePct) >= cfg.newsMinMovePercent)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, cfg.maxNewsLines);
  for (const m of news) {
    const dir = m.changePct > 0 ? 'up' : 'down';
    let why = '';
    if (m.stock.driver !== 'random' && Math.sign(m.signalPct) === Math.sign(m.changePct) && Math.abs(m.signalPct) >= 1) {
      why = m.signalPct > 0 ? ` after more ${DRIVER_TEXT[m.stock.driver]} than usual` : ` after fewer ${DRIVER_TEXT[m.stock.driver]} than usual`;
    }
    await broadcast(gameServerId, `Market news: ${m.stock.name} (${m.stock.id}) ${dir} ${formatPct(Math.abs(m.changePct)).replace('+', '')} to ${formatAmount(m.price)}${why}.`);
  }
}

await main();
