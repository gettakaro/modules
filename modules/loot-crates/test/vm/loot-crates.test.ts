import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, paginated, type ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'loot-crates (module-VM)';

const CRATES = [
  {
    name: 'basic',
    keyPrice: 100,
    rewards: [
      { name: 'Small purse', rarity: 'common', weight: 75, currency: 30, items: [] },
      { name: 'Jackpot', rarity: 'legendary', weight: 25, currency: 800, items: [] },
    ],
  },
  {
    name: 'gold',
    keyPrice: 0,
    rewards: [{ name: 'Gun pack', rarity: 'epic', weight: 1, currency: 0, items: [{ item: 'gunPistol', amount: 2 }] }],
  },
];

const userConfig = { crates: CRATES };

function seedKeys(t: ModuleTest, crate: string, count: number, playerId?: string) {
  t.variables.insert({
    key: `loot_crates_keys:${crate}`,
    value: String(count),
    gameServerId: t.gameServerId,
    playerId: playerId ?? t.pog.playerId,
    moduleId: t.moduleId,
  });
}

function keysOf(t: ModuleTest, crate: string, playerId: string) {
  const row = t.variables.all.find((v) => v.key === `loot_crates_keys:${crate}` && v.playerId === playerId);
  return row ? Number(row.value) : 0;
}

const tests = [
  createModuleTest({
    name: 'crates lists every crate with your keys and prices',
    module: MODULE,
    userConfig,
    setup: function () {
      seedKeys(this, 'gold', 2);
    },
    test: async function () {
      const result = await this.runCommand('crates');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.have.length(1);
      expect(this.pms()[0]).to.contain('basic: 0 key(s), 100 test coin/key');
      expect(this.pms()[0]).to.contain('gold: 2 key(s), shop/admin only');
    },
  }),

  createModuleTest({
    name: 'crates <name> shows the odds',
    module: MODULE,
    userConfig,
    test: async function () {
      const result = await this.runCommand('crates', { crate: 'BASIC' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()[0]).to.contain('75% [common] Small purse: 30 test coin');
      expect(this.pms()[0]).to.contain('25% [legendary] Jackpot: 800 test coin');
    },
  }),

  createModuleTest({
    name: 'buy deducts currency and adds keys',
    module: MODULE,
    userConfig,
    currency: 500,
    test: async function () {
      const result = await this.runCommand('crate', { action: 'buy', first: 'basic', second: '3' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(200);
      expect(keysOf(this, 'basic', this.pog.playerId)).to.equal(3);
      expect(this.pms()[0]).to.contain('Bought 3 basic key(s) for 300 test coin. You have 3.');
    },
  }),

  createModuleTest({
    name: 'buy applies the VIP discount permission count',
    module: MODULE,
    userConfig,
    currency: 500,
    permissions: [{ permission: 'LOOT_CRATES_KEY_DISCOUNT', count: 20 }],
    test: async function () {
      const result = await this.runCommand('crate', { action: 'buy', first: 'basic', second: '2' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(340);
      expect(this.pms()[0]).to.contain('(20% off)');
    },
  }),

  createModuleTest({
    name: 'buy refuses when the player cannot afford it',
    module: MODULE,
    userConfig,
    currency: 50,
    test: async function () {
      const result = await this.runCommand('crate', { action: 'buy', first: 'basic' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You need 100 test coin for 1 basic key(s). You have 50.');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(50);
      expect(this.variables.all).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'buy refuses crates with keyPrice 0',
    module: MODULE,
    userConfig,
    currency: 5000,
    test: async function () {
      const result = await this.runCommand('crate', { action: 'buy', first: 'gold' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('gold keys cannot be bought with test coin. Check the server shop.');
    },
  }),

  createModuleTest({
    name: 'buy rejects a bad amount and unknown crate',
    module: MODULE,
    userConfig,
    currency: 5000,
    test: async function () {
      const bad = await this.runCommand('crate', { action: 'buy', first: 'basic', second: '99' });
      expect(this.userError(bad)).to.contain('Amount must be a whole number from 1 to 10');
      const unknown = await this.runCommand('crate', { action: 'buy', first: 'diamond' });
      expect(this.userError(unknown)).to.equal('No crate called "diamond". Crates: basic, gold.');
    },
  }),

  createModuleTest({
    name: 'open without a key fails and hints at buying',
    module: MODULE,
    userConfig,
    test: async function () {
      const result = await this.runCommand('crate', { action: 'open', first: 'basic' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You have no basic keys. Buy one: /crate buy basic');
    },
  }),

  createModuleTest({
    name: 'open a common reward pays currency and does not broadcast',
    module: MODULE,
    userConfig,
    random: 0,
    setup: function () {
      seedKeys(this, 'basic', 2);
    },
    test: async function () {
      const result = await this.runCommand('crate', { action: 'open', first: 'basic' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(30);
      expect(keysOf(this, 'basic', this.pog.playerId)).to.equal(1);
      expect(this.pms()).to.deep.equal(['[COMMON] Small purse: 30 test coin. basic keys left: 1.']);
      expect(this.messages.filter((m) => !m.recipientGameId)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'open a legendary reward broadcasts to the server',
    module: MODULE,
    userConfig,
    random: 0.99,
    player: { name: 'Limon' },
    setup: function () {
      seedKeys(this, 'basic', 1);
    },
    test: async function () {
      const result = await this.runCommand('crate', { action: 'open', first: 'basic' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(800);
      expect(keysOf(this, 'basic', this.pog.playerId)).to.equal(0);
      const broadcasts = this.messages.filter((m) => !m.recipientGameId).map((m) => m.message);
      expect(broadcasts).to.deep.equal(['Limon opened a basic crate and got Jackpot (legendary)!']);
    },
  }),

  createModuleTest({
    name: 'broadcastMinRarity never disables broadcasts',
    module: MODULE,
    userConfig: { ...userConfig, broadcastMinRarity: 'never' },
    random: 0.99,
    setup: function () {
      seedKeys(this, 'basic', 1);
    },
    test: async function () {
      const result = await this.runCommand('crate', { action: 'open', first: 'basic' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages.filter((m) => !m.recipientGameId)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'open an item reward gives the items',
    module: MODULE,
    userConfig,
    setup: function () {
      seedKeys(this, 'gold', 1);
    },
    test: async function () {
      const result = await this.runCommand('crate', { action: 'open', first: 'gold' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const give = this.client.stubs.gameserver.gameServerControllerGiveItem;
      expect(give).to.have.been.calledOnceWith(this.gameServerId, this.pog.playerId, {
        name: 'gunPistol',
        amount: 2,
        quality: '',
      });
      expect(this.pms()[0]).to.equal('[EPIC] Gun pack: 2x gunPistol. gold keys left: 0.');
    },
  }),

  createModuleTest({
    name: 'open refunds the key when no item could be given',
    module: MODULE,
    userConfig,
    setup: function () {
      seedKeys(this, 'gold', 1);
      this.client.stubs.gameserver.gameServerControllerGiveItem?.callsFake(async () => {
        throw new Error('Request failed with status code 400');
      });
    },
    test: async function () {
      const result = await this.runCommand('crate', { action: 'open', first: 'gold' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.contain('Your key was refunded');
      expect(keysOf(this, 'gold', this.pog.playerId)).to.equal(1);
    },
  }),

  createModuleTest({
    name: 'givekey needs LOOT_CRATES_MANAGE',
    module: MODULE,
    userConfig,
    permissions: [],
    otherPlayers: [{ name: 'Bob' }],
    test: async function () {
      const result = await this.runCommand('crate', { action: 'givekey', first: 'Bob', second: 'gold' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You do not have permission to give crate keys.');
    },
  }),

  createModuleTest({
    name: 'givekey gives keys to another player and tells them',
    module: MODULE,
    userConfig,
    permissions: [{ permission: 'LOOT_CRATES_MANAGE' }],
    otherPlayers: [{ name: 'Bob' }],
    test: async function () {
      const bob = this.otherPlayers[0];
      const result = await this.runCommand('crate', { action: 'givekey', first: 'Bob', second: 'gold', third: '3' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(keysOf(this, 'gold', bob.pog.playerId)).to.equal(3);
      expect(this.pms()).to.deep.equal(['Gave 3 gold key(s) to Bob. They now have 3.']);
      expect(this.client.pmsTo(bob.pog.gameId)).to.deep.equal([
        'You received 3 gold crate key(s)! Open with /crate open gold',
      ]);
    },
  }),

  createModuleTest({
    name: 'givekey reports an unknown player',
    module: MODULE,
    userConfig,
    permissions: [{ permission: 'LOOT_CRATES_MANAGE' }],
    setup: function () {
      // The fake cannot do the partial `search` lookup; production returns no rows for an unknown name.
      this.client.stubs.player.playerControllerSearch?.callsFake(async () => paginated([]));
    },
    test: async function () {
      const result = await this.runCommand('crate', { action: 'givekey', first: 'Nobody', second: 'gold' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('No player called "Nobody" found on this server.');
    },
  }),

  createModuleTest({
    name: 'unknown action shows usage',
    module: MODULE,
    userConfig,
    test: async function () {
      const result = await this.runCommand('crate', { action: 'spin' });
      expect(this.userError(result)).to.contain('Usage: /crate buy <name> [amount]');
    },
  }),

  createModuleTest({
    name: 'shop action gives keys for the crate named in the listing, once per order',
    module: MODULE,
    userConfig,
    setup: function () {
      this.client.stubs.shopOrder.shopOrderControllerSearch?.callsFake(async () =>
        paginated([{ id: 'order-1', listingId: 'listing-1', amount: 2 }]),
      );
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () =>
        paginated([{ id: 'listing-1', name: '5x Gold crate key' }]),
      );
    },
    test: async function () {
      const first = await this.runShopAction('giveCrateKey', { orderId: 'order-1', triggerEvent: 'orderClaimed' });
      expect(first.success, JSON.stringify(first.logs)).to.be.true;
      expect(keysOf(this, 'gold', this.pog.playerId)).to.equal(10);
      expect(this.pms()).to.deep.equal(['You received 10 gold crate key(s)! You have 10. Open with /crate open gold']);

      const again = await this.runShopAction('giveCrateKey', { orderId: 'order-1', triggerEvent: 'orderClaimed' });
      expect(again.success, JSON.stringify(again.logs)).to.be.true;
      expect(keysOf(this, 'gold', this.pog.playerId)).to.equal(10);
    },
  }),

  createModuleTest({
    name: 'shop action fails clearly when the listing names no crate',
    module: MODULE,
    userConfig,
    setup: function () {
      this.client.stubs.shopOrder.shopOrderControllerSearch?.callsFake(async () =>
        paginated([{ id: 'order-2', listingId: 'listing-2', amount: 1, listing: { id: 'listing-2', name: 'Golden apple' } }]),
      );
    },
    test: async function () {
      const result = await this.runShopAction('giveCrateKey', { orderId: 'order-2', triggerEvent: 'orderClaimed' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(
        'The shop listing "Golden apple" does not name a crate. Rename it to include one of: basic, gold.',
      );
      expect(this.variables.all).to.have.length(0);
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
