import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, type ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const ECONOMY_ON = { economyEnabled: 'true' };
const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-11-26T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function seedVar(ctx: ModuleTest, key: string, value: unknown, playerId?: string) {
  ctx.variables.insert({
    key,
    value: JSON.stringify(value),
    gameServerId: ctx.gameServerId,
    moduleId: ctx.moduleId,
    ...(playerId ? { playerId } : {}),
  });
}

function readVar(ctx: ModuleTest, key: string, playerId?: string) {
  const rows = ctx.variables.all.filter(
    (r) => r.key === key && r.moduleId === ctx.moduleId && (playerId ? r.playerId === playerId : true),
  );
  expect(rows.length).to.be.at.most(1);
  return rows[0] ? JSON.parse(rows[0].value) : null;
}

const portfolioOf = (ctx: ModuleTest, playerId: string) => readVar(ctx, 'stx_portfolio', playerId);
const marketOf = (ctx: ModuleTest) => readVar(ctx, 'stx_market');

function seedMarket(ctx: ModuleTest, prices: Record<string, number>, extra: Record<string, unknown> = {}) {
  const stocks: Record<string, unknown> = {};
  for (const [id, price] of Object.entries(prices)) stocks[id] = { price, changePct: 0, history: [price] };
  seedVar(ctx, 'stx_market', { stocks, avg: {}, last: {}, tick: 1, ...extra });
}

const ONE_STOCK = {
  stocks: [{ id: 'DEF', name: 'Defense Corp', driver: 'kills', basePrice: 100, volatilityPercent: 2 }],
};

const tests = [
  createModuleTest({
    name: 'market lists the default stocks at their base price before the first update',
    module: MODULE,
    settings: ECONOMY_ON,
    test: async function () {
      const r = await this.runCommand('market');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      const pms = this.pms();
      expect(pms[0]).to.equal('Stock market (prices in test coin):');
      expect(pms).to.include('DEF Defense Corp: 100 (0%)');
      expect(pms).to.include('IDX Server Index: 200 (0%)');
      expect(pms).to.have.length(9);
      expect(pms[8]).to.equal('Use /stock <ticker>, /buy <ticker> <shares>, /sell <ticker> <shares|all>, /portfolio.');
      for (const line of pms) expect(line).to.not.include('\n');
    },
  }),

  createModuleTest({
    name: 'market is closed when the economy is disabled',
    module: MODULE,
    settings: { economyEnabled: 'false' },
    test: async function () {
      const r = await this.runCommand('buy', { ticker: 'DEF', amount: '1' });
      expect(this.userError(r)).to.equal('The stock market is closed: the economy is not enabled on this server.');
    },
  }),

  createModuleTest({
    name: 'buy takes price plus a fee that rounds up, and stores the holding',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 1000,
    now: NOW,
    player: { name: 'Alice' },
    setup: function () {
      seedMarket(this, { DEF: 101 });
    },
    test: async function () {
      // ticker in lower case works
      const r = await this.runCommand('buy', { ticker: 'def', amount: '3' });
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      // 303 * 3% = 9.09 -> fee 10
      expect(this.pms()).to.deep.equal([
        'Bought 3 DEF at 101 for 303 + fee 10 = 313 test coin.',
        'You now hold 3 DEF. You can sell them in 1h.',
      ]);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(687);
      const p = portfolioOf(this, this.pog.playerId);
      expect(p.holdings.DEF).to.deep.equal({ shares: 3, cost: 313, holdSince: NOW.toISOString(), lastBuyAt: NOW.toISOString() });
      expect(p.feesPaid).to.equal(10);
      expect(p.name).to.equal('Alice');
      // the trade lock is released
      expect(this.variables.all.filter((v) => v.key === 'stx_lock')).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'tiny trades still pay the minimum fee',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 100,
    userConfig: { stocks: [{ id: 'PEN', name: 'Penny', driver: 'random', basePrice: 2 }] },
    test: async function () {
      const r = await this.runCommand('buy', { ticker: 'PEN', amount: '1' });
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(this.pms()[0]).to.equal('Bought 1 PEN at 2 for 2 + fee 1 = 3 test coin.');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(97);
    },
  }),

  createModuleTest({
    name: 'fee 0 and min fee 0 make trading free (0 is not replaced by a default)',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 100,
    userConfig: { ...ONE_STOCK, feePercent: 0, minFee: 0, sellLockMinutes: 0 },
    test: async function () {
      await this.runCommand('buy', { ticker: 'DEF', amount: '1' });
      expect(this.pms()).to.deep.equal(['Bought 1 DEF at 100 for 100 + fee 0 = 100 test coin.', 'You now hold 1 DEF.']);
      const s = await this.runCommand('sell', { ticker: 'DEF', amount: 'all' });
      expect(s.success, JSON.stringify(s.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(100);
    },
  }),

  createModuleTest({
    name: 'STOCK_FEE_DISCOUNT halves the fee',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 1000,
    userConfig: { ...ONE_STOCK, feePercent: 4 },
    permissions: [{ permission: 'STOCK_FEE_DISCOUNT', count: 50 }],
    test: async function () {
      await this.runCommand('buy', { ticker: 'DEF', amount: '5' });
      expect(this.pms()[0]).to.equal('Bought 5 DEF at 100 for 500 + fee 10 = 510 test coin.');
    },
  }),

  createModuleTest({
    name: 'buy refuses bad input, too many shares, not enough money and unknown tickers',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 150,
    userConfig: { ...ONE_STOCK, maxSharesPerStock: 5 },
    test: async function () {
      const usage = 'Usage: /buy <ticker> <shares>. Example: /buy DEF 5';
      for (const args of [
        { ticker: 'none', amount: '1' },
        { ticker: 'XYZ', amount: '1' },
        { ticker: 'DEF', amount: 'none' },
        { ticker: 'DEF', amount: '0' },
        { ticker: 'DEF', amount: '-2' },
        { ticker: 'DEF', amount: '1.5' },
        { ticker: 'DEF', amount: 'all' },
      ]) {
        const r = await this.runCommand('buy', args);
        expect(this.userError(r), JSON.stringify(args)).to.equal(usage);
      }
      const many = await this.runCommand('buy', { ticker: 'DEF', amount: '6' });
      expect(this.userError(many)).to.equal('You can hold at most 5 shares of DEF. You have 0.');
      const poor = await this.runCommand('buy', { ticker: 'DEF', amount: '2' });
      expect(this.userError(poor)).to.equal('That costs 206 test coin (incl. fee 6). You have 150.');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(150);
      expect(this.variables.all.filter((v) => v.key === 'stx_portfolio')).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'STOCK_MAX_SHARES count overrides the max shares',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 10000,
    userConfig: { ...ONE_STOCK, maxSharesPerStock: 5 },
    permissions: [{ permission: 'STOCK_MAX_SHARES', count: 20 }],
    test: async function () {
      const r = await this.runCommand('buy', { ticker: 'DEF', amount: '20' });
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
    },
  }),

  createModuleTest({
    name: 'sell lock: shares cannot be sold right after buying',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 1000,
    userConfig: ONE_STOCK,
    now: NOW,
    setup: function () {
      seedVar(this, 'stx_portfolio', { holdings: { DEF: { shares: 2, cost: 206, holdSince: ago(20 * 60000), lastBuyAt: ago(20 * 60000) } } }, this.pog.playerId);
    },
    test: async function () {
      const r = await this.runCommand('sell', { ticker: 'DEF', amount: '1' });
      expect(this.userError(r)).to.equal('You just bought DEF. You can sell it in 40 min.');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(1000);
      expect(portfolioOf(this, this.pog.playerId).holdings.DEF.shares).to.equal(2);
    },
  }),

  createModuleTest({
    name: 'sell pays price minus fee, writes the portfolio and shows profit',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 0,
    userConfig: ONE_STOCK,
    now: NOW,
    setup: function () {
      seedMarket(this, { DEF: 150 });
      seedVar(this, 'stx_portfolio', { feesPaid: 10, holdings: { DEF: { shares: 10, cost: 1030, holdSince: ago(2 * DAY), lastBuyAt: ago(2 * HOUR) } } }, this.pog.playerId);
    },
    test: async function () {
      const r = await this.runCommand('sell', { ticker: 'DEF', amount: '4' });
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      // 600 * 3% = 18; cost part 1030*4/10 = 412; profit 582 - 412 = 170
      expect(this.pms()).to.deep.equal([
        'Sold 4 DEF at 150 for 600 - fee 18 = 582 test coin.',
        'Profit on these shares: +170 test coin. You still hold 6 DEF.',
      ]);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(582);
      const p = portfolioOf(this, this.pog.playerId);
      expect(p.holdings.DEF.shares).to.equal(6);
      expect(p.holdings.DEF.cost).to.equal(618);
      expect(p.feesPaid).to.equal(28);
      expect(p.realized).to.equal(170);

      const all = await this.runCommand('sell', { ticker: 'def', amount: 'all' });
      expect(all.success, JSON.stringify(all.logs)).to.be.true;
      expect(portfolioOf(this, this.pog.playerId).holdings).to.deep.equal({});
      const again = await this.runCommand('sell', { ticker: 'DEF', amount: '1' });
      expect(this.userError(again)).to.equal('You have no DEF shares.');
    },
  }),

  createModuleTest({
    name: 'selling more shares than owned is refused',
    module: MODULE,
    settings: ECONOMY_ON,
    userConfig: ONE_STOCK,
    now: NOW,
    setup: function () {
      seedVar(this, 'stx_portfolio', { holdings: { DEF: { shares: 3, cost: 300, holdSince: ago(DAY), lastBuyAt: ago(DAY) } } }, this.pog.playerId);
    },
    test: async function () {
      const r = await this.runCommand('sell', { ticker: 'DEF', amount: '4' });
      expect(this.userError(r)).to.equal('You only have 3 DEF shares.');
      const bad = await this.runCommand('sell', { ticker: 'DEF', amount: 'none' });
      expect(this.userError(bad)).to.equal('Usage: /sell <ticker> <shares|all>. See /portfolio for what you hold.');
    },
  }),

  createModuleTest({
    name: 'double sell: a running trade (lock held) blocks a second one, a stale lock is cleared',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 0,
    userConfig: { ...ONE_STOCK, feePercent: 0, minFee: 0 },
    now: NOW,
    setup: function () {
      seedVar(this, 'stx_portfolio', { holdings: { DEF: { shares: 3, cost: 300, holdSince: ago(DAY), lastBuyAt: ago(DAY) } } }, this.pog.playerId);
      seedVar(this, 'stx_lock', { at: ago(5000) }, this.pog.playerId);
    },
    test: async function () {
      const blocked = await this.runCommand('sell', { ticker: 'DEF', amount: 'all' });
      expect(this.userError(blocked)).to.equal('Another trade of yours is still running. Try again in a moment.');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);

      const lock = this.variables.all.find((v) => v.key === 'stx_lock')!;
      this.variables.update(lock.id, { value: JSON.stringify({ at: ago(5 * 60000) }) });
      const ok = await this.runCommand('sell', { ticker: 'DEF', amount: 'all' });
      expect(ok.success, JSON.stringify(ok.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(300);
      expect(this.variables.all.filter((v) => v.key === 'stx_lock')).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'two sells fired at the same time pay only once',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 0,
    userConfig: { ...ONE_STOCK, feePercent: 0, minFee: 0 },
    now: NOW,
    setup: function () {
      seedVar(this, 'stx_portfolio', { holdings: { DEF: { shares: 3, cost: 300, holdSince: ago(DAY), lastBuyAt: ago(DAY) } } }, this.pog.playerId);
    },
    test: async function () {
      const results = await Promise.all([
        this.runCommand('sell', { ticker: 'DEF', amount: '3' }),
        this.runCommand('sell', { ticker: 'DEF', amount: '3' }),
      ]);
      expect(results.filter((r) => r.success)).to.have.length(1);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(300);
      expect(portfolioOf(this, this.pog.playerId).holdings).to.deep.equal({});
    },
  }),

  createModuleTest({
    name: 'a delisted stock can be sold at its last price but not bought',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 1000,
    userConfig: { ...ONE_STOCK, feePercent: 0, minFee: 0 },
    now: NOW,
    setup: function () {
      seedMarket(this, { DEF: 100, OLD: 70 });
      seedVar(this, 'stx_portfolio', { holdings: { OLD: { shares: 2, cost: 100, holdSince: ago(DAY), lastBuyAt: ago(DAY) } } }, this.pog.playerId);
    },
    test: async function () {
      const buy = await this.runCommand('buy', { ticker: 'OLD', amount: '1' });
      expect(this.userError(buy)).to.equal('OLD is no longer listed. You can only sell it.');
      const sell = await this.runCommand('sell', { ticker: 'OLD', amount: 'all' });
      expect(sell.success, JSON.stringify(sell.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(1140);
    },
  }),

  createModuleTest({
    name: 'config changes apply live: a lower ceiling caps the trade price at once',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 1000,
    userConfig: { ...ONE_STOCK, ceilingPercent: 120, feePercent: 0, minFee: 0 },
    setup: function () {
      seedMarket(this, { DEF: 390 });
    },
    test: async function () {
      await this.runCommand('buy', { ticker: 'DEF', amount: '1' });
      expect(this.pms()[0]).to.equal('Bought 1 DEF at 120 for 120 + fee 0 = 120 test coin.');
    },
  }),

  createModuleTest({
    name: 'stock shows details, range, history and the holding',
    module: MODULE,
    settings: ECONOMY_ON,
    userConfig: ONE_STOCK,
    now: NOW,
    setup: function () {
      seedVar(this, 'stx_market', { stocks: { DEF: { price: 110, changePct: 4.8, history: [100, 105, 110] } }, tick: 3 });
      seedVar(this, 'stx_portfolio', { holdings: { DEF: { shares: 4, cost: 400, holdSince: ago(DAY), lastBuyAt: ago(DAY) } } }, this.pog.playerId);
    },
    test: async function () {
      const r = await this.runCommand('stock', { ticker: 'def' });
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'DEF Defense Corp: 110 test coin (+4.8% last update).',
        'Moves with: monster kills. Base 100, range 25 to 400.',
        'Last prices: 100, 105, 110',
        'You hold 4 shares, worth 440 test coin.',
        'Fee 3% per trade (min 1).',
      ]);
      const none = await this.runCommand('stock');
      expect(this.userError(none)).to.equal('Usage: /stock <ticker>. Tickers: DEF.');
    },
  }),

  createModuleTest({
    name: 'portfolio shows value, profit, sell lock and hold bonus',
    module: MODULE,
    settings: ECONOMY_ON,
    userConfig: {
      stocks: [
        { id: 'DEF', name: 'Defense Corp', driver: 'kills', basePrice: 100 },
        { id: 'GOLD', name: 'Gold Rush', driver: 'random', basePrice: 150 },
      ],
    },
    now: NOW,
    setup: function () {
      seedMarket(this, { DEF: 120, GOLD: 140 });
      seedVar(this, 'stx_portfolio', {
        feesPaid: 25,
        realized: 40,
        trades: 3,
        holdings: {
          DEF: { shares: 5, cost: 515, holdSince: ago(8 * DAY), lastBuyAt: ago(8 * DAY) },
          GOLD: { shares: 2, cost: 309, holdSince: ago(30 * 60000), lastBuyAt: ago(30 * 60000) },
        },
      }, this.pog.playerId);
    },
    test: async function () {
      const r = await this.runCommand('portfolio');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Your portfolio (test coin):',
        'DEF: 5 x 120 = 600 (+85) [hold bonus]',
        'GOLD: 2 x 140 = 280 (-29) [sell in 30 min, hold bonus in 7d]',
        'Total value 880, paid 824, open profit +56.',
        'Realized profit +40. Fees paid 25. Fees fund the dividends.',
      ]);
    },
  }),

  createModuleTest({
    name: 'hooks count kills, deaths and only travel commands',
    module: MODULE,
    settings: ECONOMY_ON,
    permissions: [],
    test: async function () {
      await this.runHook('on-entity-killed', { eventData: { entity: 'zombie' } });
      await this.runHook('on-entity-killed', { eventData: { entity: 'zombie' } });
      await this.runHook('on-player-death', { eventData: {} });
      const tp = await this.runHook('on-command-executed', { eventData: { command: { name: 'teleport', trigger: 'tp' } } });
      expect(tp.success, JSON.stringify(tp.logs)).to.be.true;
      await this.runHook('on-command-executed', { eventData: { command: { name: 'buy', trigger: 'buy' } } });
      await this.runHook('on-command-executed', { eventData: { command: { name: 'home', trigger: 'home' }, result: { success: false } } });
      expect(readVar(this, 'stx_sig_kills').count).to.equal(2);
      expect(readVar(this, 'stx_sig_deaths').count).to.equal(1);
      expect(readVar(this, 'stx_sig_travel').count).to.equal(1);
    },
  }),

  createModuleTest({
    name: 'update-prices: pull back to base, max move cap, floor and ceiling, history',
    module: MODULE,
    settings: ECONOMY_ON,
    random: 0.5,
    userConfig: {
      stocks: [
        { id: 'HI', name: 'High', driver: 'random', basePrice: 100, volatilityPercent: 0 },
        { id: 'LO', name: 'Low', driver: 'random', basePrice: 100, volatilityPercent: 0 },
        { id: 'NEW', name: 'New', driver: 'random', basePrice: 50, volatilityPercent: 0 },
        { id: 'CAP', name: 'Capped', driver: 'random', basePrice: 100, volatilityPercent: 0 },
      ],
      reversionPercent: 50,
      maxMovePercent: 10,
      newsMinMovePercent: 0,
      ceilingPercent: 150,
    },
    setup: function () {
      seedMarket(this, { HI: 300, LO: 26, CAP: 900 });
    },
    test: async function () {
      const r = await this.runCronJob('update-prices');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      const m = marketOf(this);
      // HI starts clamped to the ceiling 150: pull back 50% * (100-150)/150 = -16.7% -> capped -10% -> 135
      expect(m.stocks.HI.price).to.equal(135);
      // LO 26: +142% capped +10% -> 28.6 -> 29
      expect(m.stocks.LO.price).to.equal(29);
      // NEW has no price yet: starts at base, no move
      expect(m.stocks.NEW.price).to.equal(50);
      expect(m.stocks.CAP.price).to.equal(135);
      expect(m.stocks.LO.history).to.deep.equal([26, 29]);
      expect(m.tick).to.equal(2);
      expect(this.messages).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'update-prices: many kills push the kills stock up, news only after the move',
    module: MODULE,
    settings: ECONOMY_ON,
    random: 0.5,
    userConfig: {
      stocks: [
        { id: 'DEF', name: 'Defense Corp', driver: 'kills', basePrice: 100, volatilityPercent: 0 },
        { id: 'MED', name: 'Field Medics', driver: 'deaths', basePrice: 100, volatilityPercent: 0 },
      ],
      reversionPercent: 0,
      signalStrengthPercent: 5,
    },
    setup: function () {
      seedMarket(this, { DEF: 100, MED: 100 }, { avg: { kills: 10, deaths: 4, travel: 0, players: 1 } });
      seedVar(this, 'stx_sig_kills', { count: 30 });
      seedVar(this, 'stx_sig_deaths', { count: 4 });
    },
    test: async function () {
      const r = await this.runCronJob('update-prices');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      const m = marketOf(this);
      // kills 30 vs avg 10 -> delta 2 -> +10%
      expect(m.stocks.DEF.price).to.equal(110);
      expect(m.stocks.MED.price).to.equal(100);
      expect(m.last.kills).to.equal(30);
      expect(m.avg.kills).to.equal(16);
      expect(readVar(this, 'stx_sig_kills').count).to.equal(0);
      expect(this.messages.map((x) => x.message)).to.deep.equal([
        'Market news: Defense Corp (DEF) up 10% to 110 after more monster kills than usual.',
      ]);
    },
  }),

  createModuleTest({
    name: 'update-prices: players online drives the index stock',
    module: MODULE,
    settings: ECONOMY_ON,
    random: 0.5,
    userConfig: {
      stocks: [{ id: 'IDX', name: 'Server Index', driver: 'players', basePrice: 200, volatilityPercent: 0 }],
      reversionPercent: 0,
      newsMinMovePercent: 0,
    },
    otherPlayers: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    setup: function () {
      seedMarket(this, { IDX: 200 }, { avg: { players: 2 } });
    },
    test: async function () {
      const r = await this.runCronJob('update-prices');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      const m = marketOf(this);
      // 4 online vs avg 2 -> delta 1 -> +10%
      expect(m.last.players).to.equal(4);
      expect(m.stocks.IDX.price).to.equal(220);
    },
  }),

  createModuleTest({
    name: 'pay-dividends: pays part of the fee pool by holding value with the hold bonus, books it first',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 0,
    now: NOW,
    userConfig: { ...ONE_STOCK, dividendPayoutPercent: 50, holdStreakDays: 7, holdBonusPercent: 100 },
    permissions: [],
    otherPlayers: [{ name: 'Bob' }, { name: 'Carol', online: false }],
    setup: function () {
      seedMarket(this, { DEF: 100 });
      // fees paid: 100 + 80 + 20 = 200 -> payout 100
      seedVar(this, 'stx_portfolio', { feesPaid: 100, holdings: { DEF: { shares: 10, cost: 1000, holdSince: ago(10 * DAY), lastBuyAt: ago(10 * DAY) } } }, this.pog.playerId);
      seedVar(this, 'stx_portfolio', { feesPaid: 80, holdings: { DEF: { shares: 10, cost: 1000, holdSince: ago(DAY), lastBuyAt: ago(DAY) } } }, this.otherPlayers[0].pog.playerId);
      seedVar(this, 'stx_portfolio', { feesPaid: 20, holdings: {} }, this.otherPlayers[1].pog.playerId);
    },
    test: async function () {
      const r = await this.runCronJob('pay-dividends');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      // weights: me 1000*2 = 2000, Bob 1000 -> 66 / 33
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(66);
      expect(this.currency.balanceOf(this.otherPlayers[0].pog.playerId)).to.equal(33);
      expect(this.currency.balanceOf(this.otherPlayers[1].pog.playerId)).to.equal(0);
      expect(this.pms()).to.deep.equal(['Stock dividend: +66 test coin from the trade fee pool. Hold bonus included.']);
      expect(this.client.pmsTo(this.otherPlayers[0].pog.gameId)).to.deep.equal(['Stock dividend: +33 test coin from the trade fee pool.']);
      const ledger = readVar(this, 'stx_dividends');
      expect(ledger.paid).to.equal(99);
      expect(ledger.runs).to.equal(1);
      expect(this.messages.at(-1)!.message).to.equal('Stock dividends paid: 99 test coin to 2 shareholders.');

      // Second run only pays from what is left: pool 101 -> 50
      await this.runCronJob('pay-dividends');
      expect(readVar(this, 'stx_dividends').paid).to.equal(99 + 49);
    },
  }),

  createModuleTest({
    name: 'pay-dividends with an empty pool or no holders pays nothing',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 0,
    userConfig: ONE_STOCK,
    permissions: [],
    setup: function () {
      seedVar(this, 'stx_portfolio', { feesPaid: 50, holdings: {} }, this.pog.playerId);
    },
    test: async function () {
      const r = await this.runCronJob('pay-dividends');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);
      expect(readVar(this, 'stx_dividends')).to.equal(null);
      expect(this.messages).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'marketadmin needs STOCK_ADMIN',
    module: MODULE,
    settings: ECONOMY_ON,
    permissions: [],
    test: async function () {
      const r = await this.runCommand('marketadmin');
      expect(this.userError(r)).to.equal('You do not have permission to see market stats.');
    },
  }),

  createModuleTest({
    name: 'marketadmin shows fees in, dividends out, pool and money in the market',
    module: MODULE,
    settings: ECONOMY_ON,
    userConfig: ONE_STOCK,
    permissions: [{ permission: 'STOCK_ADMIN' }],
    otherPlayers: [{ name: 'Bob' }],
    setup: function () {
      seedMarket(this, { DEF: 100 }, { tick: 7, last: { kills: 12, deaths: 1, travel: 3, players: 5 } });
      seedVar(this, 'stx_portfolio', { name: 'Alice', feesPaid: 60, trades: 4, holdings: { DEF: { shares: 10, cost: 1000 } } }, this.pog.playerId);
      seedVar(this, 'stx_portfolio', { name: 'Bob', feesPaid: 40, trades: 2, holdings: { DEF: { shares: 3, cost: 300 } } }, this.otherPlayers[0].pog.playerId);
      seedVar(this, 'stx_dividends', { paid: 30, runs: 1 });
    },
    test: async function () {
      const r = await this.runCommand('marketadmin');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Market: 2 traders, 2 holders, 13 shares worth 1,300 test coin.',
        'Fees in 100. Dividends out 30 in 1 run. Fee pool now 70.',
        'Top holders: Alice 1,000, Bob 300.',
        'Last update #7: kills 12, deaths 1, travel 3, online 5.',
      ]);
    },
  }),
];

describe('stock-exchange suite (module-VM)', function () {
  tests.forEach((test) => {
    test.run();
  });
});
