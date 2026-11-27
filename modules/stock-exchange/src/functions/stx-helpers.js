import { takaro, checkPermission, TakaroUserError } from '@takaro/helpers';

export const MARKET_KEY = 'stx_market';
export const DIVIDENDS_KEY = 'stx_dividends';
export const PORTFOLIO_KEY = 'stx_portfolio';
export const LOCK_KEY = 'stx_lock';
export const SIGNAL_KEYS = { kills: 'stx_sig_kills', deaths: 'stx_sig_deaths', travel: 'stx_sig_travel' };
export const DRIVER_TEXT = {
  kills: 'monster kills',
  deaths: 'player deaths',
  players: 'players online',
  travel: 'teleports',
  random: 'market mood only',
};
const LOCK_STALE_MS = 60000;
const PAGE_SIZE = 100;

export const DEFAULT_STOCKS = [
  { id: 'DEF', name: 'Defense Corp', driver: 'kills', basePrice: 100, volatilityPercent: 2 },
  { id: 'MED', name: 'Field Medics', driver: 'deaths', basePrice: 80, volatilityPercent: 2 },
  { id: 'IDX', name: 'Server Index', driver: 'players', basePrice: 200, volatilityPercent: 1 },
  { id: 'TRVL', name: 'Travel Inc', driver: 'travel', basePrice: 60, volatilityPercent: 2 },
  { id: 'GOLD', name: 'Gold Rush', driver: 'random', basePrice: 150, volatilityPercent: 5 },
  { id: 'TECH', name: 'Tech Works', driver: 'random', basePrice: 120, volatilityPercent: 4 },
  { id: 'FARM', name: 'Farm Fresh', driver: 'random', basePrice: 40, volatilityPercent: 3 },
];

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Reads the user config with `??` defaults, so 0 is a valid value everywhere. Read on every run: changes apply live. */
export function readConfig(userConfig) {
  const c = userConfig ?? {};
  const rawStocks = Array.isArray(c.stocks) ? c.stocks : DEFAULT_STOCKS;
  const seen = new Set();
  const stocks = [];
  for (const s of rawStocks) {
    if (!s || typeof s !== 'object') continue;
    const id = String(s.id ?? '').trim().toUpperCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const driver = DRIVER_TEXT[s.driver] ? s.driver : 'random';
    stocks.push({
      id,
      name: String(s.name ?? id),
      driver,
      basePrice: Math.max(1, Math.floor(num(s.basePrice, 100))),
      volatilityPercent: Math.max(0, num(s.volatilityPercent, 3)),
    });
  }
  return {
    stocks,
    maxMovePercent: Math.max(0, num(c.maxMovePercent ?? 10, 10)),
    reversionPercent: Math.min(100, Math.max(0, num(c.reversionPercent ?? 15, 15))),
    signalStrengthPercent: Math.max(0, num(c.signalStrengthPercent ?? 10, 10)),
    floorPercent: Math.max(1, num(c.floorPercent ?? 25, 25)),
    ceilingPercent: Math.max(100, num(c.ceilingPercent ?? 400, 400)),
    feePercent: Math.max(0, num(c.feePercent ?? 3, 3)),
    minFee: Math.max(0, Math.floor(num(c.minFee ?? 1, 1))),
    sellLockMinutes: Math.max(0, num(c.sellLockMinutes ?? 60, 60)),
    maxSharesPerStock: Math.max(1, Math.floor(num(c.maxSharesPerStock ?? 100, 100))),
    newsMinMovePercent: Math.max(0, num(c.newsMinMovePercent ?? 5, 5)),
    maxNewsLines: Math.max(0, Math.floor(num(c.maxNewsLines ?? 3, 3))),
    dividendPayoutPercent: Math.min(100, Math.max(0, num(c.dividendPayoutPercent ?? 50, 50))),
    holdStreakDays: Math.max(0, num(c.holdStreakDays ?? 7, 7)),
    holdBonusPercent: Math.max(0, num(c.holdBonusPercent ?? 25, 25)),
    travelCommands: Array.isArray(c.travelCommands)
      ? c.travelCommands.map((w) => String(w).trim().toLowerCase()).filter(Boolean)
      : ['tp', 'teleport', 'warp', 'home'],
    historyLength: Math.max(2, Math.floor(num(c.historyLength ?? 8, 8))),
  };
}

export function formatAmount(value) {
  const n = Math.trunc(Number(value) || 0);
  const sign = n < 0 ? '-' : '';
  return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function signed(value) {
  const n = Math.trunc(Number(value) || 0);
  return n > 0 ? `+${formatAmount(n)}` : formatAmount(n);
}

export function formatPct(pct) {
  const r = Math.round((Number(pct) || 0) * 10) / 10;
  return r > 0 ? `+${r}%` : `${r}%`;
}

export function formatMinutes(ms) {
  const mins = Math.max(1, Math.ceil(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export async function getSetting(key, gameServerId, fallback) {
  try {
    const res = await takaro.settings.settingsControllerGetOne(key, gameServerId);
    return res.data.data.value ?? fallback;
  } catch (err) {
    console.log(`stock-exchange: could not read setting ${key}: ${err}`);
    return fallback;
  }
}

/** Prefix, currency name and economy switch, read in order. */
export async function getServerTexts(gameServerId) {
  const prefix = await getSetting('commandPrefix', gameServerId, '/');
  const currency = await getSetting('currencyName', gameServerId, 'coins');
  const economy = await getSetting('economyEnabled', gameServerId, 'false');
  return { prefix, currency, economyEnabled: String(economy) === 'true' };
}

function parseJson(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

async function findVar(filters) {
  const res = await takaro.variable.variableControllerSearch({ filters });
  return res.data.data[0] ?? null;
}

export async function saveVar(row, scope, key, value) {
  const serialized = JSON.stringify(value);
  if (row) {
    await takaro.variable.variableControllerUpdate(row.id, { value: serialized });
    return row.id;
  }
  const created = await takaro.variable.variableControllerCreate({ key, value: serialized, ...scope });
  return created.data.data.id;
}

// ---------- market state (written only by the update-prices cron) ----------

export async function getMarketRow(gameServerId, moduleId) {
  return findVar({ key: [MARKET_KEY], gameServerId: [gameServerId], moduleId: [moduleId] });
}

export function parseMarket(row) {
  const m = row ? parseJson(row.value, {}) : {};
  return {
    stocks: m.stocks && typeof m.stocks === 'object' ? m.stocks : {},
    avg: m.avg && typeof m.avg === 'object' ? m.avg : {},
    last: m.last && typeof m.last === 'object' ? m.last : {},
    tick: Math.floor(num(m.tick, 0)),
    lastTickAt: typeof m.lastTickAt === 'string' ? m.lastTickAt : null,
  };
}

export function priceBounds(stock, cfg) {
  const floor = Math.max(1, Math.round((stock.basePrice * cfg.floorPercent) / 100));
  const ceiling = Math.max(floor, Math.round((stock.basePrice * cfg.ceilingPercent) / 100));
  return { floor, ceiling };
}

/** Current price of a listed stock: the stored price, clamped to today's floor/ceiling (config is live). */
export function currentPrice(stock, market, cfg) {
  const { floor, ceiling } = priceBounds(stock, cfg);
  const stored = market.stocks[stock.id];
  const price = stored && Number.isFinite(Number(stored.price)) ? Math.round(Number(stored.price)) : stock.basePrice;
  return Math.min(ceiling, Math.max(floor, price));
}

export function lastChangePct(stockId, market) {
  const s = market.stocks[stockId];
  return s ? num(s.changePct, 0) : 0;
}

/** Finds a stock by ticker (any case). Delisted stocks with a stored price are returned with `delisted: true`. */
export function findStock(ticker, cfg, market) {
  const id = String(ticker ?? '').trim().toUpperCase();
  if (!id || id === 'NONE') return null;
  const listed = cfg.stocks.find((s) => s.id === id);
  if (listed) return { ...listed, price: currentPrice(listed, market, cfg), delisted: false };
  const stored = market.stocks[id];
  if (stored && Number(stored.price) > 0) {
    return { id, name: stored.name ?? id, driver: 'random', price: Math.round(Number(stored.price)), delisted: true };
  }
  return null;
}

/**
 * One price update. Returns { price, changePct, signalPct }.
 * change = noise + pull back to base + signal, capped at maxMovePercent; result clamped to floor/ceiling.
 */
export function nextPrice(stock, prevPrice, signalDelta, cfg, rand) {
  const noise = (rand * 2 - 1) * stock.volatilityPercent;
  const reversion = (cfg.reversionPercent * (stock.basePrice - prevPrice)) / prevPrice;
  const signalPct = stock.driver === 'random' ? 0 : cfg.signalStrengthPercent * signalDelta;
  let change = noise + reversion + signalPct;
  change = Math.max(-cfg.maxMovePercent, Math.min(cfg.maxMovePercent, change));
  const { floor, ceiling } = priceBounds(stock, cfg);
  const price = Math.min(ceiling, Math.max(floor, Math.round(prevPrice * (1 + change / 100))));
  const changePct = ((price - prevPrice) / prevPrice) * 100;
  return { price, changePct, signalPct };
}

/** How far a signal is from its usual level: -1 (none) to +2 (triple). 0 when there is no history yet. */
export function signalDelta(value, avg) {
  if (!Number.isFinite(avg)) return 0;
  const d = (value - avg) / Math.max(avg, 1);
  return Math.max(-1, Math.min(2, d));
}

// ---------- signal counters (written by hooks, read + reset by the cron) ----------

export async function bumpSignal(gameServerId, moduleId, signal) {
  const key = SIGNAL_KEYS[signal];
  const filters = { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] };
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await findVar(filters);
    try {
      const count = row ? Math.floor(num(parseJson(row.value, {}).count, 0)) : 0;
      await saveVar(row, { gameServerId, moduleId }, key, { count: count + 1 });
      return;
    } catch (err) {
      if (!isConflict(err) || attempt === 1) throw err;
    }
  }
}

/** Reads every counter and sets it back to 0. A hook that lands in between may lose one count; it is only a signal. */
export async function takeSignals(gameServerId, moduleId) {
  const out = {};
  for (const [signal, key] of Object.entries(SIGNAL_KEYS)) {
    const row = await findVar({ key: [key], gameServerId: [gameServerId], moduleId: [moduleId] });
    out[signal] = row ? Math.max(0, Math.floor(num(parseJson(row.value, {}).count, 0))) : 0;
    if (row && out[signal] > 0) await saveVar(row, null, key, { count: 0 });
  }
  return out;
}

export async function countOnline(gameServerId) {
  const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: { gameServerId: [gameServerId], online: [true] },
    limit: 1,
  });
  const total = res.data.meta && Number.isFinite(res.data.meta.total) ? res.data.meta.total : res.data.data.length;
  return total;
}

// ---------- portfolios ----------

export function parsePortfolio(row) {
  const p = row ? parseJson(row.value, {}) : {};
  const holdings = {};
  if (p.holdings && typeof p.holdings === 'object') {
    for (const [id, h] of Object.entries(p.holdings)) {
      const shares = Math.max(0, Math.floor(num(h && h.shares, 0)));
      if (shares <= 0) continue;
      holdings[id] = {
        shares,
        cost: Math.max(0, Math.floor(num(h.cost, 0))),
        holdSince: typeof h.holdSince === 'string' ? h.holdSince : null,
        lastBuyAt: typeof h.lastBuyAt === 'string' ? h.lastBuyAt : null,
      };
    }
  }
  return {
    name: typeof p.name === 'string' ? p.name : null,
    holdings,
    feesPaid: Math.max(0, Math.floor(num(p.feesPaid, 0))),
    realized: Math.floor(num(p.realized, 0)),
    trades: Math.max(0, Math.floor(num(p.trades, 0))),
  };
}

export async function getPortfolioRow(gameServerId, moduleId, playerId) {
  return findVar({ key: [PORTFOLIO_KEY], gameServerId: [gameServerId], moduleId: [moduleId], playerId: [playerId] });
}

export async function listPortfolioRows(gameServerId, moduleId) {
  const rows = [];
  for (let page = 0; page < 1000; page++) {
    const res = await takaro.variable.variableControllerSearch({
      filters: { key: [PORTFOLIO_KEY], gameServerId: [gameServerId], moduleId: [moduleId] },
      page,
      limit: PAGE_SIZE,
    });
    rows.push(...res.data.data);
    if (res.data.data.length < PAGE_SIZE) break;
  }
  return rows;
}

// ---------- dividends ledger (written only by the pay-dividends cron) ----------

export async function getDividendsRow(gameServerId, moduleId) {
  return findVar({ key: [DIVIDENDS_KEY], gameServerId: [gameServerId], moduleId: [moduleId] });
}

export function parseDividends(row) {
  const d = row ? parseJson(row.value, {}) : {};
  return {
    paid: Math.max(0, Math.floor(num(d.paid, 0))),
    runs: Math.max(0, Math.floor(num(d.runs, 0))),
    lastAt: typeof d.lastAt === 'string' ? d.lastAt : null,
    lastAmount: Math.max(0, Math.floor(num(d.lastAmount, 0))),
    lastHolders: Math.max(0, Math.floor(num(d.lastHolders, 0))),
  };
}

/** Fee pool = all fees ever paid minus all dividends ever paid. Race-free: fees live in player rows, payouts in the cron's row. */
export function poolFrom(portfolios, dividends) {
  const fees = portfolios.reduce((sum, p) => sum + p.feesPaid, 0);
  return { fees, paid: dividends.paid, pool: Math.max(0, fees - dividends.paid) };
}

// ---------- fees, limits ----------

function permCount(pog, perm) {
  const p = pog ? checkPermission(pog, perm) : false;
  return p && typeof p === 'object' && Number.isFinite(p.count) && p.count > 0 ? p.count : 0;
}

export function feeFor(value, cfg, pog) {
  if (value <= 0) return 0;
  const discount = Math.min(100, permCount(pog, 'STOCK_FEE_DISCOUNT'));
  const pct = cfg.feePercent * (1 - discount / 100);
  const minFee = discount >= 100 ? 0 : cfg.minFee;
  return Math.max(minFee, Math.ceil((value * pct) / 100));
}

export function maxSharesFor(cfg, pog) {
  return permCount(pog, 'STOCK_MAX_SHARES') || cfg.maxSharesPerStock;
}

export function parseShares(raw) {
  const text = String(raw ?? '').trim().toLowerCase().replace(/,/g, '');
  if (text === 'all' || text === 'max') return 'all';
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

// ---------- per-player trade lock ----------

export function isConflict(err) {
  const status = err && (err.status ?? (err.response && err.response.status));
  return status === 409 || String(err && err.message).includes('409');
}

/**
 * Runs fn while holding a per-player lock (a unique variable). Two parallel trades of one player
 * cannot both read the same portfolio: the second create gets a 409 and is refused.
 */
export async function withTradeLock(gameServerId, moduleId, playerId, fn) {
  const scope = { gameServerId, moduleId, playerId };
  let lockId = null;
  for (let attempt = 0; attempt < 2 && !lockId; attempt++) {
    try {
      const created = await takaro.variable.variableControllerCreate({
        key: LOCK_KEY,
        value: JSON.stringify({ at: new Date().toISOString() }),
        ...scope,
      });
      lockId = created.data.data.id;
    } catch (err) {
      if (!isConflict(err)) throw err;
      const row = await findVar({ key: [LOCK_KEY], gameServerId: [gameServerId], moduleId: [moduleId], playerId: [playerId] });
      const at = row ? Date.parse(parseJson(row.value, {}).at) : NaN;
      if (row && (!Number.isFinite(at) || Date.now() - at > LOCK_STALE_MS)) {
        console.log('stock-exchange: removing a stale trade lock');
        await takaro.variable.variableControllerDelete(row.id);
        continue;
      }
      throw new TakaroUserError('Another trade of yours is still running. Try again in a moment.');
    }
  }
  if (!lockId) throw new TakaroUserError('Another trade of yours is still running. Try again in a moment.');
  try {
    return await fn();
  } finally {
    try {
      await takaro.variable.variableControllerDelete(lockId);
    } catch (err) {
      console.error(`stock-exchange: could not release trade lock: ${err}`);
    }
  }
}

export async function broadcast(gameServerId, message) {
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message });
}

export async function requireEconomy(gameServerId) {
  const texts = await getServerTexts(gameServerId);
  if (!texts.economyEnabled) {
    throw new TakaroUserError('The stock market is closed: the economy is not enabled on this server.');
  }
  return texts;
}
