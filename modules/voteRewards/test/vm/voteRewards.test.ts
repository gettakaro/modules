import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, single } from '@takaro/module-test';
import type { ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'Vote rewards (module-VM)';

const NOW = new Date('2026-10-29T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const VOTE_ID = '3c9d5e1a-7b24-4f80-9a6e-2d1c0b8f4e57';
const OTHER_VOTE_ID = '9e1f4a7c-2b36-4d58-8c90-1a2b3c4d5e6f';
const SET_ID = '8e2f6a10-3c47-4d95-b1a8-5f0d9c7e2b64';
const ROLE_ID = '6a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const SWORD = { id: '0d3f1c86-24a1-4b2e-9d4c-6f1b8a5e7c30', name: 'Sword', code: 'sword' };
const SHIELD = { id: '5b7e2a94-8c31-4f60-a7d2-13c9e6b04a8f', name: 'Shield', code: 'shield' };
const THANKS = 'Thanks for voting for this server! Your reward has been delivered.';

const verifiedVote = (voteId = VOTE_ID) => ({
  voteId,
  verified: true,
  verifiedBy: 'player_link',
  castAt: '2026-10-29T11:59:00.000Z',
});

const fullConfig = { currency: 50, itemSet: SET_ID, role: ROLE_ID, commands: ['givexp {gameId} 10'] };

type Line = typeof SWORD;
const result = (item: Line, amount: number, outcome: 'DELIVERED' | 'FAILED') => ({
  itemId: item.id,
  code: item.code,
  name: item.name,
  amount,
  result: outcome,
});

function stubSet(test: ModuleTest, outcomes: Array<'DELIVERED' | 'FAILED'> = ['DELIVERED', 'DELIVERED']) {
  test.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () =>
    single({
      id: SET_ID,
      gameServerId: test.gameServerId,
      name: 'Vote kit',
      lines: [
        { itemId: SWORD.id, amount: 1, position: 0 },
        { itemId: SHIELD.id, amount: 2, position: 1 },
      ],
    }),
  );
  test.client.stubs.gameserver.gameServerControllerGiveItems?.callsFake(async () =>
    single({ lines: [result(SWORD, 1, outcomes[0]), result(SHIELD, 2, outcomes[1])] }),
  );
}

function seedPending(test: ModuleTest, voteId: string) {
  return test.variables.insert({
    key: `vote_pending_${voteId}`,
    value: JSON.stringify({ voteId, castAt: '2026-10-28T00:00:00.000Z' }),
    expiresAt: new Date(NOW.getTime() + 10 * 24 * HOUR).toISOString(),
    gameServerId: test.gameServerId,
    playerId: test.pog.playerId,
    moduleId: test.moduleId,
  });
}

const pendingKeys = (test: ModuleTest) =>
  test.variables.all.filter((v) => v.key.startsWith('vote_pending_')).map((v) => v.key);

const base = { module: MODULE, now: NOW, settings: { economyEnabled: 'true' } };

const tests = [
  createModuleTest({
    ...base,
    name: 'voteCast pays an online verified voter at once',
    userConfig: fullConfig,
    setup: function () {
      stubSet(this);
    },
    test: async function () {
      const res = await this.runHook('voteCast', { eventData: verifiedVote() });

      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(50);
      expect(this.client.stubs.player.playerControllerAssignRole).to.have.been.calledOnceWith(
        this.pog.playerId,
        ROLE_ID,
        { gameServerId: this.gameServerId, expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString() },
      );
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems?.firstCall.args).to.deep.equal([
        this.gameServerId,
        this.pog.playerId,
        {
          lines: [
            { itemId: SWORD.id, amount: 1 },
            { itemId: SHIELD.id, amount: 2 },
          ],
        },
      ]);
      expect(this.client.stubs.gameserver.gameServerControllerExecuteCommand).to.have.been.calledOnceWith(
        this.gameServerId,
        { command: `givexp ${this.pog.gameId} 10` },
      );
      expect(this.pms()).to.deep.equal([THANKS]);
      expect(pendingKeys(this)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    ...base,
    name: 'voteCast holds the in-game part for an offline voter and pays currency and role now',
    userConfig: fullConfig,
    player: { online: false },
    setup: function () {
      stubSet(this);
    },
    test: async function () {
      const res = await this.runHook('voteCast', { eventData: verifiedVote() });

      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(50);
      expect(this.client.stubs.player.playerControllerAssignRole).to.have.been.calledOnce;
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.not.have.been.called;
      expect(this.client.stubs.gameserver.gameServerControllerExecuteCommand).to.not.have.been.called;
      expect(this.pms()).to.deep.equal([]);
      const pending = this.variables.all.filter((v) => v.key === `vote_pending_${VOTE_ID}`);
      expect(pending).to.have.length(1);
      expect(pending[0].playerId).to.equal(this.pog.playerId);
      expect(pending[0].moduleId).to.equal(this.moduleId);
      expect(pending[0].expiresAt).to.equal(new Date(NOW.getTime() + 30 * 24 * HOUR).toISOString());
    },
  }),

  createModuleTest({
    ...base,
    name: 'voteCast keeps one waiting reward when the same offline vote arrives twice',
    userConfig: { itemSet: SET_ID, currency: 0 },
    player: { online: false },
    test: async function () {
      expect((await this.runHook('voteCast', { eventData: verifiedVote() })).success).to.be.true;
      const again = await this.runHook('voteCast', { eventData: verifiedVote() });

      expect(again.success, JSON.stringify(again.logs)).to.be.true;
      expect(pendingKeys(this)).to.deep.equal([`vote_pending_${VOTE_ID}`]);
    },
  }),

  createModuleTest({
    ...base,
    name: 'voteCast never rewards an unverified vote, even one that names a player',
    userConfig: fullConfig,
    test: async function () {
      const res = await this.runHook('voteCast', {
        eventData: { voteId: VOTE_ID, verified: false, castAt: '2026-10-29T11:59:00.000Z' },
      });

      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);
      expect(this.client.stubs.player.playerControllerAssignRole).to.not.have.been.called;
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.not.have.been.called;
      expect(this.client.stubs.gameserver.gameServerControllerExecuteCommand).to.not.have.been.called;
      expect(this.variables.all).to.deep.equal([]);
    },
  }),

  createModuleTest({
    ...base,
    name: 'voteCast does nothing for a vote without a player',
    userConfig: fullConfig,
    test: async function () {
      const res = await this.runHook('voteCast', { eventData: verifiedVote(), withPlayer: false });

      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(this.client.stubs.playerOnGameserver.playerOnGameServerControllerAddCurrency).to.not.have.been.called;
      expect(this.client.stubs.player.playerControllerAssignRole).to.not.have.been.called;
    },
  }),

  createModuleTest({
    ...base,
    name: 'voteCast skips currency while the economy is off and still gives role and items',
    userConfig: { ...fullConfig, commands: [] },
    settings: { economyEnabled: 'false' },
    setup: function () {
      stubSet(this);
    },
    test: async function () {
      const res = await this.runHook('voteCast', { eventData: verifiedVote() });

      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(this.client.stubs.playerOnGameserver.playerOnGameServerControllerAddCurrency).to.not.have.been.called;
      expect(this.client.stubs.player.playerControllerAssignRole).to.have.been.calledOnce;
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.have.been.calledOnce;
    },
  }),

  createModuleTest({
    ...base,
    name: 'voteCast assigns a permanent role when its duration is 0',
    userConfig: { role: ROLE_ID, roleDurationHours: 0, currency: 0 },
    test: async function () {
      const res = await this.runHook('voteCast', { eventData: verifiedVote() });

      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(this.client.stubs.player.playerControllerAssignRole).to.have.been.calledOnceWith(
        this.pog.playerId,
        ROLE_ID,
        { gameServerId: this.gameServerId },
      );
    },
  }),

  createModuleTest({
    ...base,
    name: 'voteCast never puts an unsafe gameId into a console command',
    userConfig: { currency: 0, commands: ['vip {steamId}', 'givexp {gameId} 10'] },
    player: { gameId: 'player;kill all' },
    test: async function () {
      const res = await this.runHook('voteCast', { eventData: verifiedVote() });

      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerExecuteCommand).to.not.have.been.called;
    },
  }),

  createModuleTest({
    ...base,
    name: 'voteCast runs a command with a missing steamId skipped and a safe gameId substituted',
    userConfig: { currency: 0, commands: ['vip {steamId}', 'givexp {gameId} 10'] },
    test: async function () {
      const res = await this.runHook('voteCast', { eventData: verifiedVote() });

      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      const execute = this.client.stubs.gameserver.gameServerControllerExecuteCommand;
      expect(execute).to.have.been.calledOnceWith(this.gameServerId, { command: `givexp ${this.pog.gameId} 10` });
    },
  }),

  createModuleTest({
    ...base,
    name: 'voteCast fails with a player-facing error when the item set is gone, after paying currency',
    userConfig: { currency: 50, itemSet: SET_ID },
    setup: function () {
      this.client.stubs.itemSet.itemSetControllerGetOne?.callsFake(async () => {
        const error: Error & { response?: unknown } = new Error('Request failed with status code 404');
        error.response = { status: 404 };
        throw error;
      });
    },
    test: async function () {
      const res = await this.runHook('voteCast', { eventData: verifiedVote() });

      expect(res.success).to.be.false;
      expect(this.userError(res)).to.equal(
        'The vote reward item set no longer exists. Please ask your server administrator to reconfigure vote rewards.',
      );
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(50);
      expect(pendingKeys(this)).to.deep.equal([`vote_pending_${VOTE_ID}`]);
    },
  }),

  createModuleTest({
    ...base,
    name: 'voteCast never shortens a role the voter already holds permanently',
    userConfig: { role: ROLE_ID, currency: 0 },
    setup: function () {
      this.player.roleAssignments.push({
        id: '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9',
        playerId: this.pog.playerId,
        roleId: ROLE_ID,
        role: {
          id: ROLE_ID,
          name: 'VIP',
          permissions: [],
          system: false,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
    },
    test: async function () {
      const res = await this.runHook('voteCast', { eventData: verifiedVote() });

      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(this.client.stubs.player.playerControllerAssignRole).to.not.have.been.called;
    },
  }),

  createModuleTest({
    ...base,
    name: 'deliverPendingOnConnect puts a reward back when delivery throws',
    userConfig: { itemSet: SET_ID },
    setup: function () {
      stubSet(this);
      this.client.stubs.gameserver.gameServerControllerGiveItems?.callsFake(async () => {
        throw new Error('Request failed with status code 500');
      });
      seedPending(this, VOTE_ID);
    },
    test: async function () {
      const res = await this.runHook('deliverPendingOnConnect');

      expect(res.success).to.be.false;
      expect(pendingKeys(this)).to.deep.equal([`vote_pending_${VOTE_ID}`]);
    },
  }),

  createModuleTest({
    ...base,
    name: 'a command failing after the items were given keeps the claim spent',
    userConfig: { itemSet: SET_ID, commands: ['givexp {gameId} 10'] },
    setup: function () {
      stubSet(this);
      this.client.stubs.gameserver.gameServerControllerExecuteCommand?.callsFake(async () => {
        throw new Error('Request failed with status code 500');
      });
      seedPending(this, VOTE_ID);
    },
    test: async function () {
      const first = await this.runCommand('claimvote');
      expect(first.success).to.be.false;
      expect(pendingKeys(this)).to.deep.equal([]);

      const second = await this.runCommand('claimvote');
      expect(second.success, JSON.stringify(second.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.have.been.calledOnce;
      expect(this.pms()).to.deep.equal(['You have no vote rewards waiting.']);
    },
  }),

  createModuleTest({
    ...base,
    name: 'deliverPendingOnConnect delivers every waiting reward and clears them',
    userConfig: { itemSet: SET_ID, currency: 0 },
    setup: function () {
      stubSet(this);
      seedPending(this, VOTE_ID);
      seedPending(this, OTHER_VOTE_ID);
    },
    test: async function () {
      const res = await this.runHook('deliverPendingOnConnect');

      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.have.been.calledTwice;
      expect(pendingKeys(this)).to.deep.equal([]);
      expect(this.pms()).to.deep.equal([THANKS]);
    },
  }),

  createModuleTest({
    ...base,
    name: 'deliverPendingOnConnect stays silent when nothing waits',
    userConfig: { itemSet: SET_ID },
    test: async function () {
      const res = await this.runHook('deliverPendingOnConnect');

      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([]);
      expect(this.client.stubs.itemSet.itemSetControllerGetOne).to.not.have.been.called;
    },
  }),

  createModuleTest({
    ...base,
    name: 'deliverPendingOnConnect keeps the reward waiting when every item fails',
    userConfig: { itemSet: SET_ID, commands: ['givexp {gameId} 10'] },
    setup: function () {
      stubSet(this, ['FAILED', 'FAILED']);
      seedPending(this, VOTE_ID);
    },
    test: async function () {
      const res = await this.runHook('deliverPendingOnConnect');

      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(pendingKeys(this)).to.deep.equal([`vote_pending_${VOTE_ID}`]);
      expect(this.client.stubs.gameserver.gameServerControllerExecuteCommand).to.not.have.been.called;
      expect(this.pms()).to.deep.equal(['Your vote reward could not be delivered. Use /claimvote to try again later.']);
    },
  }),

  createModuleTest({
    ...base,
    name: 'deliverPendingOnConnect names the items that failed in a partial delivery',
    userConfig: { itemSet: SET_ID },
    setup: function () {
      stubSet(this, ['DELIVERED', 'FAILED']);
      seedPending(this, VOTE_ID);
    },
    test: async function () {
      const res = await this.runHook('deliverPendingOnConnect');

      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(pendingKeys(this)).to.deep.equal([]);
      expect(this.pms()).to.deep.equal([
        'Some vote reward items could not be given: Shield x2. Please contact a server administrator.',
        THANKS,
      ]);
    },
  }),

  createModuleTest({
    ...base,
    name: '/claimvote says so when nothing waits',
    userConfig: { itemSet: SET_ID },
    test: async function () {
      const res = await this.runCommand('claimvote');

      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['You have no vote rewards waiting.']);
    },
  }),

  createModuleTest({
    ...base,
    name: '/claimvote delivers a waiting reward',
    userConfig: { itemSet: SET_ID },
    setup: function () {
      stubSet(this);
      seedPending(this, VOTE_ID);
    },
    test: async function () {
      const res = await this.runCommand('claimvote');

      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerGiveItems).to.have.been.calledOnce;
      expect(pendingKeys(this)).to.deep.equal([]);
      expect(this.pms()).to.deep.equal([THANKS]);
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => test.run());
});
