import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, single } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'Onboarding - Starterkit (module-VM)';

const LOCK_KEY = 't_starterkit_lock';
const SET_ID = '8e2f6a10-3c47-4d95-b1a8-5f0d9c7e2b64';

const SWORD = { id: '0d3f1c86-24a1-4b2e-9d4c-6f1b8a5e7c30', name: 'Sword', code: 'sword' };
const SHIELD = { id: '5b7e2a94-8c31-4f60-a7d2-13c9e6b04a8f', name: 'Shield', code: 'shield' };

const MISSING_SET =
  'The starter kit item set no longer exists. Please ask your server administrator to reconfigure the starter kit.';

function httpError(status: number, message: string) {
  const error: Error & { response?: unknown } = new Error(`Request failed with status code ${status}`);
  error.response = { status, data: { meta: { error: { message } } } };
  return error;
}

function line(item: typeof SWORD, amount: number, result: 'DELIVERED' | 'FAILED' | 'UNKNOWN') {
  return { itemId: item.id, code: item.code, name: item.name, amount, result };
}

const setLines = [
  { itemId: SWORD.id, amount: 3, quality: '2', position: 0 },
  { itemId: SHIELD.id, amount: 1, position: 1 },
];

function starterSet(gameServerId: string, lines: unknown[] = setLines) {
  return { id: SET_ID, gameServerId, name: 'Starter', lines };
}

const userConfig = { starterKitItemSet: SET_ID };

const tests = [
  createModuleTest({
    name: 'Starterkit gives every line of the item set in one call',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () => single(starterSet(this.gameServerId)));
      this.client.stubs.gameserver.gameServerControllerGiveItems?.callsFake(async () =>
        single({ lines: [line(SWORD, 3, 'DELIVERED'), line(SHIELD, 1, 'DELIVERED')] }),
      );
    },
    test: async function () {
      const result = await this.runCommand('starterkit');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['You are about to receive your starter kit...', 'Gave 2 items, enjoy!']);
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

      expect(this.variables.all).to.have.length(1);
      const lock = this.variables.all[0];
      expect(lock.key).to.equal(LOCK_KEY);
      expect(lock.value).to.equal('1');
      expect(lock.gameServerId).to.equal(this.gameServerId);
      expect(lock.playerId).to.equal(this.pog.playerId);
    },
  }),

  createModuleTest({
    name: 'Starterkit with one failed line locks the kit and names the failed item',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () => single(starterSet(this.gameServerId)));
      this.client.stubs.gameserver.gameServerControllerGiveItems?.callsFake(async () =>
        single({ lines: [line(SWORD, 3, 'DELIVERED'), line(SHIELD, 1, 'FAILED')] }),
      );
    },
    test: async function () {
      const result = await this.runCommand('starterkit');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.variables.all).to.have.length(1);
      expect(this.pms().at(-1)).to.equal(
        'Gave 1 of 2 items. These could not be given: Shield x1. Please contact a server administrator.',
      );
    },
  }),

  createModuleTest({
    name: 'Starterkit with an unknown line locks the kit and says it may not have arrived',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () => single(starterSet(this.gameServerId)));
      this.client.stubs.gameserver.gameServerControllerGiveItems?.callsFake(async () =>
        single({ lines: [line(SWORD, 3, 'DELIVERED'), line(SHIELD, 1, 'UNKNOWN')] }),
      );
    },
    test: async function () {
      const result = await this.runCommand('starterkit');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.variables.all).to.have.length(1);
      expect(this.pms().at(-1)).to.equal(
        'Gave 1 of 2 items. These may not have arrived: Shield x1. Please contact a server administrator.',
      );
    },
  }),

  createModuleTest({
    name: 'Starterkit where every line failed does not lock the kit',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () => single(starterSet(this.gameServerId)));
      this.client.stubs.gameserver.gameServerControllerGiveItems?.callsFake(async () =>
        single({ lines: [line(SWORD, 3, 'FAILED'), line(SHIELD, 1, 'FAILED')] }),
      );
    },
    test: async function () {
      const result = await this.runCommand('starterkit');

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(
        'Your starter kit could not be given. Please try again later or contact a server administrator.',
      );
      expect(this.variables.all).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Starterkit rejected by the give endpoint reports why and does not lock the kit',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () => single(starterSet(this.gameServerId)));
      this.client.stubs.gameserver.gameServerControllerGiveItems?.callsFake(async () => {
        throw httpError(400, 'Player is not online');
      });
    },
    test: async function () {
      const result = await this.runCommand('starterkit');

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('Your starter kit could not be given: Player is not online');
      expect(this.variables.all).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Starterkit with a deleted item set tells the player and does not lock the kit',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () => {
        throw httpError(404, 'Item set not found');
      });
    },
    test: async function () {
      const result = await this.runCommand('starterkit');

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(MISSING_SET);
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.not.have.been.called;
      expect(this.pms()).to.deep.equal([]);
      expect(this.variables.all).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Starterkit with an item set of another game server is treated as missing',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () =>
        single(starterSet('another-game-server-id')),
      );
    },
    test: async function () {
      const result = await this.runCommand('starterkit');

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(MISSING_SET);
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.not.have.been.called;
      expect(this.variables.all).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Starterkit with an empty item set shows an error message',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () =>
        single(starterSet(this.gameServerId, [])),
      );
    },
    test: async function () {
      const result = await this.runCommand('starterkit');

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(
        'The starter kit item set has no items. Please ask your server administrator to configure this.',
      );
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.not.have.been.called;
      expect(this.variables.all).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Starterkit with nothing configured, shows an error message',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      const result = await this.runCommand('starterkit');

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(
        'No starter kit item set configured. Please ask your server administrator to configure this.',
      );
      expect(this.client.stubs.itemSet.itemSetControllerGetOne).to.not.have.been.called;
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.not.have.been.called;
      expect(this.pms()).to.deep.equal([]);
      expect(this.variables.all).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Starterkit already claimed is rejected without reading the set',
    module: MODULE,
    permissions: 'ROOT',
    userConfig,
    setup: function () {
      this.variables.insert({
        key: LOCK_KEY,
        value: '1',
        gameServerId: this.gameServerId,
        playerId: this.pog.playerId,
      });
    },
    test: async function () {
      const result = await this.runCommand('starterkit');

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You already used starterkit on this server');
      expect(this.client.stubs.itemSet.itemSetControllerGetOne).to.not.have.been.called;
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.not.have.been.called;
      expect(this.variables.all).to.have.length(1);
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
