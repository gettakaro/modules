import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, single } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const DAY = 24 * 60 * 60 * 1000;
// A Thursday; its week starts Monday 2026-11-02.
const NOW = new Date('2026-11-05T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const ECONOMY_ON = { economyEnabled: 'true', currencyName: 'coins' };
const ECONOMY_OFF = { economyEnabled: 'false', currencyName: 'coins' };
const ITEM_ID = '0d3f1c86-24a1-4b2e-9d4c-6f1b8a5e7c30';

/** Makes the acting player an existing player who was last seen `daysAway` days before NOW. */
function returning(daysAway: number) {
  return function (this: { pog: { lastSeen?: string; createdAt?: string } }) {
    this.pog.lastSeen = ago(daysAway);
    this.pog.createdAt = ago(daysAway + 100);
  };
}

function variable(t: { variables: { all: Array<{ key: string; value: string }> } }, key: string) {
  const row = t.variables.all.find((r) => r.key === key);
  return row ? JSON.parse(row.value) : undefined;
}

const hookTests = [
  createModuleTest({
    name: 'Rewards the lowest tier after 10 days away, PMs, and records stats',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    setup: returning(10),
    test: async function () {
      const result = await this.runHook('welcome-back', { eventType: 'player-connected' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(100);
      expect(this.pms()).to.deep.equal(['Welcome back Test player! You were away 10 days. Here\'s 100 coins.']);
      expect(variable(this, 'welcome_back_last')).to.deep.include({ lastSeen: ago(10), days: 10 });
      expect(variable(this, 'welcome_back_weekly')).to.deep.equal({
        '2026-11-02': { returns: 1, rewarded: 1, currency: 100 },
      });
      expect(this.messages).to.have.length(1);
    },
  }),

  createModuleTest({
    name: 'Picks the 30-day tier and applies the VIP permission count as multiplier',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    permissions: [{ permission: 'WELCOME_BACK_CLAIM', count: 2 }],
    setup: returning(45),
    test: async function () {
      const result = await this.runHook('welcome-back', { eventType: 'player-connected' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(600);
      expect(this.pms()).to.deep.equal(['Welcome back Test player! You were away 45 days. Here\'s 600 coins.']);
    },
  }),

  createModuleTest({
    name: 'Uses the lowest tier when minDaysAway is below every tier',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    userConfig: { minDaysAway: 3 },
    setup: returning(4),
    test: async function () {
      await this.runHook('welcome-back', { eventType: 'player-connected' });
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(100);
    },
  }),

  createModuleTest({
    name: 'Does nothing when the player was away less than minDaysAway',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    setup: returning(6),
    test: async function () {
      const result = await this.runHook('welcome-back', { eventType: 'player-connected' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([]);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);
      expect(this.variables.all).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'Skips brand-new players (first join belongs to onboarding)',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    setup: function () {
      this.pog.createdAt = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
      this.pog.lastSeen = ago(30);
    },
    test: async function () {
      const result = await this.runHook('welcome-back', { eventType: 'player-connected' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([]);
      expect(this.variables.all).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'Pays an absence only once, even when connect fires twice',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    setup: returning(10),
    test: async function () {
      await this.runHook('welcome-back', { eventType: 'player-connected' });
      const second = await this.runHook('welcome-back', { eventType: 'player-connected' });

      expect(second.success, JSON.stringify(second.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(100);
      expect(this.pms()).to.have.length(1);
      expect(variable(this, 'welcome_back_weekly')['2026-11-02'].returns).to.equal(1);
    },
  }),

  createModuleTest({
    name: 'Skips an absence that was already rewarded (lock expired)',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    setup: function () {
      returning(10).call(this);
      this.variables.insert({
        key: 'welcome_back_last',
        value: JSON.stringify({ at: NOW.getTime() - DAY, lastSeen: ago(10), days: 9 }),
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
        playerId: this.pog.playerId,
      });
    },
    test: async function () {
      await this.runHook('welcome-back', { eventType: 'player-connected' });
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);
      expect(this.pms()).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Rewards a new absence after an earlier one',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    setup: function () {
      returning(8).call(this);
      this.variables.insert({
        key: 'welcome_back_last',
        value: JSON.stringify({ at: NOW.getTime() - 40 * DAY, lastSeen: ago(70), days: 30 }),
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
        playerId: this.pog.playerId,
      });
    },
    test: async function () {
      await this.runHook('welcome-back', { eventType: 'player-connected' });
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(100);
      expect(variable(this, 'welcome_back_last')).to.deep.include({ lastSeen: ago(8), days: 8 });
    },
  }),

  createModuleTest({
    name: 'Without WELCOME_BACK_CLAIM: greeting only, counted as returned but not rewarded',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    permissions: [],
    setup: returning(12),
    test: async function () {
      const result = await this.runHook('welcome-back', { eventType: 'player-connected' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);
      expect(this.pms()).to.deep.equal(['Welcome back Test player! You were away 12 days.']);
      expect(variable(this, 'welcome_back_weekly')).to.deep.equal({
        '2026-11-02': { returns: 1, rewarded: 0, currency: 0 },
      });
    },
  }),

  createModuleTest({
    name: 'Economy off: skips currency, still gives items scaled by the tier',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_OFF,
    userConfig: { items: [{ item: ITEM_ID, amount: 2, quality: '3' }] },
    setup: function () {
      returning(95).call(this);
      this.client.stubs.item.itemControllerFindOne?.resolves(single({ id: ITEM_ID, name: 'Medkit', code: 'medkit' }) as never);
    },
    test: async function () {
      const result = await this.runHook('welcome-back', { eventType: 'player-connected' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);
      expect(this.client.stubs.gameserver.gameServerControllerGiveItem).to.have.been.calledOnceWith(
        this.gameServerId,
        this.pog.playerId,
        { name: ITEM_ID, amount: 6, quality: '3' },
      );
      expect(this.pms()).to.deep.equal(['Welcome back Test player! You were away 95 days. Here\'s 6x Medkit.']);
    },
  }),

  createModuleTest({
    name: 'A failed item delivery is reported to the player',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    userConfig: { items: [{ item: ITEM_ID, amount: 1 }] },
    setup: function () {
      returning(10).call(this);
      this.client.stubs.gameserver.gameServerControllerGiveItem?.rejects(new Error('not supported'));
    },
    test: async function () {
      const result = await this.runHook('welcome-back', { eventType: 'player-connected' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(100);
      expect(this.pms()).to.deep.equal([
        'Welcome back Test player! You were away 10 days. Here\'s 100 coins.',
        '1 reward item(s) could not be delivered. Please contact an admin.',
      ]);
    },
  }),

  createModuleTest({
    name: 'Broadcasts the return when enabled',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    userConfig: { broadcast: true },
    setup: returning(10),
    test: async function () {
      await this.runHook('welcome-back', { eventType: 'player-connected' });

      const broadcasts = this.messages.filter((m) => !m.recipientGameId);
      expect(broadcasts.map((m) => m.message)).to.deep.equal([
        'Test player is back after 10 days away. Welcome back!',
      ]);
    },
  }),
];

const STATS = JSON.stringify({
  '2026-10-19': { returns: 2, rewarded: 2, currency: 200 },
  '2026-11-02': { returns: 3, rewarded: 2, currency: 400 },
});

const statsTests = [
  createModuleTest({
    name: 'welcomebackstats lists returns per week, newest first',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    setup: function () {
      this.variables.insert({ key: 'welcome_back_weekly', value: STATS, gameServerId: this.gameServerId, moduleId: this.moduleId });
    },
    test: async function () {
      const result = await this.runCommand('welcomebackstats', { weeks: 3 });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Welcome-back stats, last 3 week(s) (5 returns):',
        '2026-11-02 (this week): 3 returned, 2 rewarded, 400 coins',
        '2026-10-26: 0 returned, 0 rewarded, 0 coins',
        '2026-10-19: 2 returned, 2 rewarded, 200 coins',
      ]);
    },
  }),

  createModuleTest({
    name: 'welcomebackstats works with no data yet',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    test: async function () {
      const result = await this.runCommand('welcomebackstats', { weeks: 1 });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Welcome-back stats, last 1 week(s) (0 returns):',
        '2026-11-02 (this week): 0 returned, 0 rewarded, 0 coins',
      ]);
    },
  }),

  createModuleTest({
    name: 'welcomebackstats rejects an out-of-range week count',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    test: async function () {
      const result = await this.runCommand('welcomebackstats', { weeks: 99 });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.match(/Weeks must be a number from 1 to 26/);
    },
  }),

  createModuleTest({
    name: 'welcomebackstats is denied without WELCOME_BACK_STATS',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    permissions: [{ permission: 'WELCOME_BACK_CLAIM' }],
    test: async function () {
      const result = await this.runCommand('welcomebackstats', { weeks: 4 });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.match(/do not have permission/);
    },
  }),
];

describe('welcome-back hook (module-VM)', function () {
  hookTests.forEach((t) => t.run());
});

describe('welcome-back stats command (module-VM)', function () {
  statsTests.forEach((t) => t.run());
});
