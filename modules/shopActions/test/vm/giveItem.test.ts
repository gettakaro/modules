import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, single } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'shopActions - giveItem (module-VM)';

const SET_ID = '8e2f6a10-3c47-4d95-b1a8-5f0d9c7e2b64';
const SWORD = { id: '0d3f1c86-24a1-4b2e-9d4c-6f1b8a5e7c30', name: 'Sword', code: 'sword' };
const SHIELD = { id: '5b7e2a94-8c31-4f60-a7d2-13c9e6b04a8f', name: 'Shield', code: 'shield' };

const SET_MISSING =
  'The item set configured for the giveItem shop action no longer exists. Reconfigure the shopActions module.';
const SET_EMPTY = 'The item set configured for the giveItem shop action has no items.';
const NO_PLAYER = 'Player data is not available for this shop action.';

function httpError(status: number, message: string) {
  const error: Error & { response?: unknown } = new Error(`Request failed with status code ${status}`);
  error.response = { status, data: { meta: { error: { message } } } };
  return error;
}

type Result = 'DELIVERED' | 'FAILED' | 'UNKNOWN';

function givenLines(sword: Result, shield: Result) {
  return {
    lines: [
      { itemId: SWORD.id, code: SWORD.code, name: SWORD.name, amount: 3, result: sword },
      { itemId: SHIELD.id, code: SHIELD.code, name: SHIELD.name, amount: 1, result: shield },
    ],
  };
}

function bonusSet(gameServerId: string, lines: unknown[] = defaultLines) {
  return { id: SET_ID, gameServerId, name: 'Bonus', lines };
}

const defaultLines = [
  { itemId: SWORD.id, amount: 3, quality: '2', position: 0 },
  { itemId: SHIELD.id, amount: 1, position: 1 },
];

const userConfig = { giveItem: { itemSet: SET_ID } };
const trigger = { triggerEvent: 'orderClaimed' } as const;

const tests = [
  createModuleTest({
    name: 'Gives every line of the item set in one call',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () => single(bonusSet(this.gameServerId)));
      this.client.stubs.gameserver.gameServerControllerGiveItems?.callsFake(async () =>
        single(givenLines('DELIVERED', 'DELIVERED')),
      );
    },
    test: async function () {
      const result = await this.runShopAction('giveItem', trigger);

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.itemSet.itemSetControllerGetOne).to.have.been.calledOnceWith(SET_ID);
      const giveItems = this.client.stubs.gameserver.gameServerControllerGiveItems;
      expect(giveItems).to.have.been.calledOnce;
      expect(giveItems?.firstCall.args).to.deep.equal([
        this.gameServerId,
        this.pog.playerId,
        {
          lines: [
            { itemId: SWORD.id, amount: 3, quality: '2' },
            { itemId: SHIELD.id, amount: 1 },
          ],
        },
      ]);
      expect(this.client.stubs.gameserver.gameServerControllerGiveItem).to.not.have.been.called;
      expect(this.pms()).to.deep.equal(['You received 2 bonus item(s) from your purchase!']);
    },
  }),

  createModuleTest({
    name: 'A partly failed give succeeds and lists the failed line',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () => single(bonusSet(this.gameServerId)));
      this.client.stubs.gameserver.gameServerControllerGiveItems?.callsFake(async () =>
        single(givenLines('DELIVERED', 'FAILED')),
      );
    },
    test: async function () {
      const result = await this.runShopAction('giveItem', trigger);

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'You received 1 of 2 bonus item(s) from your purchase. These could not be given: Shield x1. Please contact a server administrator.',
      ]);
    },
  }),

  createModuleTest({
    name: 'An unknown line succeeds and is reported as possibly not arrived',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () => single(bonusSet(this.gameServerId)));
      this.client.stubs.gameserver.gameServerControllerGiveItems?.callsFake(async () =>
        single(givenLines('DELIVERED', 'UNKNOWN')),
      );
    },
    test: async function () {
      const result = await this.runShopAction('giveItem', trigger);

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'You received 1 of 2 bonus item(s) from your purchase. These may not have arrived: Shield x1. Please contact a server administrator.',
      ]);
    },
  }),

  createModuleTest({
    name: 'Every line failed tells the buyer and fails the action',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () => single(bonusSet(this.gameServerId)));
      this.client.stubs.gameserver.gameServerControllerGiveItems?.callsFake(async () =>
        single(givenLines('FAILED', 'FAILED')),
      );
    },
    test: async function () {
      const result = await this.runShopAction('giveItem', trigger);

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('The giveItem shop action could not give any item: Sword x3, Shield x1');
      expect(this.pms()).to.deep.equal([
        'Your bonus items could not be given: Sword x3, Shield x1. Please contact a server administrator.',
      ]);
    },
  }),

  createModuleTest({
    name: 'A give rejected with 400 fails with the API message and no PM',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () => single(bonusSet(this.gameServerId)));
      this.client.stubs.gameserver.gameServerControllerGiveItems?.callsFake(async () => {
        throw httpError(400, 'Player is not online');
      });
    },
    test: async function () {
      const result = await this.runShopAction('giveItem', trigger);

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(
        'The giveItem shop action could not give the item set: Player is not online',
      );
      expect(this.pms()).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'A deleted item set fails the action and gives nothing',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () => {
        throw httpError(404, 'Item set not found');
      });
    },
    test: async function () {
      const result = await this.runShopAction('giveItem', trigger);

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(SET_MISSING);
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.not.have.been.called;
      expect(this.pms()).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'An item set of another game server is treated as missing',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () =>
        single(bonusSet('c4a1e7d2-9b35-4f08-a6c3-2d7e5b19f804')),
      );
    },
    test: async function () {
      const result = await this.runShopAction('giveItem', trigger);

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(SET_MISSING);
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.not.have.been.called;
      expect(this.pms()).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'An empty item set fails the action and gives nothing',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () => single(bonusSet(this.gameServerId, [])));
    },
    test: async function () {
      const result = await this.runShopAction('giveItem', trigger);

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(SET_EMPTY);
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.not.have.been.called;
      expect(this.pms()).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Nothing configured fails before any API call',
    module: MODULE,
    permissions: 'ROOT',
    userConfig: {},
    test: async function () {
      const result = await this.runShopAction('giveItem', trigger);

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('No item set configured for the giveItem shop action.');
      expect(this.client.stubs.itemSet.itemSetControllerGetOne).to.not.have.been.called;
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.not.have.been.called;
      expect(this.pms()).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'No player fails the action',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    test: async function () {
      const result = await this.runShopAction('giveItem', { ...trigger, withPlayer: false });

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(NO_PLAYER);
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.not.have.been.called;
    },
  }),

];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
