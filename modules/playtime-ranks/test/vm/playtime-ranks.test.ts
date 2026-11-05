import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import sinon from 'sinon';
import { createModuleTest, ok } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const ROLE_NEWBIE = '11111111-1111-4111-8111-111111111111';
const ROLE_REGULAR = '22222222-2222-4222-8222-222222222222';
const ROLE_VETERAN = '33333333-3333-4333-8333-333333333333';
const ROLE_LEGEND = '44444444-4444-4444-8444-444444444444';

const RANKS = [
  { name: 'Newbie', hours: 0, roleId: ROLE_NEWBIE, reward: 0, message: '' },
  { name: 'Regular', hours: 10, roleId: ROLE_REGULAR, reward: 100, message: '' },
  { name: 'Veteran', hours: 50, roleId: ROLE_VETERAN, reward: 500, message: 'Welcome to the veterans, {player}!' },
  { name: 'Legend', hours: 200, roleId: ROLE_LEGEND, reward: 2000, message: '' },
];

const ECONOMY_ON = { economyEnabled: 'true' };
const HOUR = 3600;

type Pog = { roles: unknown[]; playtimeSeconds: number; online: boolean; playerId: string; gameServerId: string };

/** Adds a role assignment to a fixture POG, the shape Takaro returns in `pog.roles`. */
function giveRole(pog: Pog, roleId: string, name: string) {
  pog.roles.push({
    id: `assignment-${roleId}`,
    playerId: pog.playerId,
    roleId,
    gameServerId: pog.gameServerId,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    role: { id: roleId, name, system: false, permissions: [], createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
  });
}

function stateRows(test: { variables: { all: Array<{ key: string; value: string; playerId?: string | null }> } }) {
  return test.variables.all.filter((row) => row.key === 'playtime_rank_state');
}

const tests = [
  createModuleTest({
    name: 'Cron promotes an online player: role, reward, PM and broadcast',
    module: MODULE,
    userConfig: { ranks: RANKS },
    settings: ECONOMY_ON,
    player: { name: 'Alice' },
    setup: function () {
      (this.pog as unknown as Pog).playtimeSeconds = 12.5 * HOUR;
    },
    test: async function () {
      const result = await this.runCronJob('check-ranks');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;

      const assign = this.client.stubs.player.playerControllerAssignRole;
      expect(assign).to.have.been.calledOnceWith(this.pog.playerId, ROLE_REGULAR, { gameServerId: this.gameServerId });

      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(100);
      expect(this.pms()).to.deep.equal([
        'Congratulations Alice! You reached the rank Regular after 12.5 h of playtime. Type /rank to see your progress.',
        'You received 100 test coin for reaching Regular!',
      ]);
      const broadcasts = this.messages.filter((m) => m.recipientGameId === undefined).map((m) => m.message);
      expect(broadcasts).to.deep.equal(['Alice has reached the rank Regular after 12.5 h on the server!']);

      const rows = stateRows(this);
      expect(rows).to.have.length(1);
      expect(rows[0].playerId).to.equal(this.pog.playerId);
      const state = JSON.parse(rows[0].value);
      expect(state.rank).to.equal('Regular');
      expect(state.rewarded).to.deep.equal(['Regular']);
    },
  }),

  createModuleTest({
    name: 'Second cron run does not repeat messages, roles or rewards',
    module: MODULE,
    userConfig: { ranks: RANKS },
    settings: ECONOMY_ON,
    setup: function () {
      (this.pog as unknown as Pog).playtimeSeconds = 12 * HOUR;
    },
    test: async function () {
      await this.runCronJob('check-ranks');
      // Takaro would now list the new role on the POG.
      giveRole(this.pog as unknown as Pog, ROLE_REGULAR, 'Regular');
      const messagesAfterFirst = this.messages.length;

      const second = await this.runCronJob('check-ranks');
      expect(second.success, JSON.stringify(second.logs)).to.be.true;
      expect(this.client.stubs.player.playerControllerAssignRole).to.have.been.calledOnce;
      expect(this.messages.length).to.equal(messagesAfterFirst);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(100);
    },
  }),

  createModuleTest({
    name: 'Promotion removes lower rank roles and leaves other roles alone',
    module: MODULE,
    userConfig: { ranks: RANKS },
    settings: ECONOMY_ON,
    player: { name: 'Bob' },
    setup: function () {
      const pog = this.pog as unknown as Pog;
      pog.playtimeSeconds = 60 * HOUR;
      giveRole(pog, ROLE_NEWBIE, 'Newbie');
      giveRole(pog, ROLE_REGULAR, 'Regular');
      // The fake has no removeRole; add one with the real (empty) envelope.
      (this.client.stubs.player as Record<string, unknown>).playerControllerRemoveRole = sinon.stub().resolves(ok({ meta: {} }));
    },
    test: async function () {
      const remove = (this.client.stubs.player as Record<string, sinon.SinonStub>).playerControllerRemoveRole;

      const result = await this.runCronJob('check-ranks');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;

      expect(this.client.stubs.player.playerControllerAssignRole).to.have.been.calledOnceWith(this.pog.playerId, ROLE_VETERAN, {
        gameServerId: this.gameServerId,
      });
      const removed = remove.getCalls().map((c) => c.args[1]).sort();
      expect(removed).to.deep.equal([ROLE_NEWBIE, ROLE_REGULAR].sort());
      expect(remove.firstCall.args[2]).to.deep.equal({ gameServerId: this.gameServerId });

      // Skipped Regular too, so both one-time rewards are paid.
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(600);
      expect(this.pms()[0]).to.equal('Welcome to the veterans, Bob!');
      expect(this.pms()[1]).to.equal('You received 600 test coin for reaching Veteran!');
    },
  }),

  createModuleTest({
    name: 'Never removes a higher rank role an admin gave by hand',
    module: MODULE,
    userConfig: { ranks: RANKS },
    settings: ECONOMY_ON,
    setup: function () {
      const pog = this.pog as unknown as Pog;
      pog.playtimeSeconds = 12 * HOUR;
      giveRole(pog, ROLE_LEGEND, 'Legend');
      (this.client.stubs.player as Record<string, unknown>).playerControllerRemoveRole = sinon.stub().resolves(ok({ meta: {} }));
    },
    test: async function () {
      const remove = (this.client.stubs.player as Record<string, sinon.SinonStub>).playerControllerRemoveRole;
      const result = await this.runCronJob('check-ranks');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.player.playerControllerAssignRole).to.have.been.calledOnceWith(this.pog.playerId, ROLE_REGULAR);
      expect(remove).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'removePreviousRoles=false keeps lower rank roles',
    module: MODULE,
    userConfig: { ranks: RANKS, removePreviousRoles: false },
    settings: ECONOMY_ON,
    setup: function () {
      const pog = this.pog as unknown as Pog;
      pog.playtimeSeconds = 60 * HOUR;
      giveRole(pog, ROLE_REGULAR, 'Regular');
      (this.client.stubs.player as Record<string, unknown>).playerControllerRemoveRole = sinon.stub().resolves(ok({ meta: {} }));
    },
    test: async function () {
      const remove = (this.client.stubs.player as Record<string, sinon.SinonStub>).playerControllerRemoveRole;
      const result = await this.runCronJob('check-ranks');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.player.playerControllerAssignRole).to.have.been.calledOnceWith(this.pog.playerId, ROLE_VETERAN);
      expect(remove).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'Base rank (0 h) is given silently, without PM or broadcast',
    module: MODULE,
    userConfig: { ranks: RANKS },
    settings: ECONOMY_ON,
    test: async function () {
      const result = await this.runCronJob('check-ranks');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.player.playerControllerAssignRole).to.have.been.calledOnceWith(this.pog.playerId, ROLE_NEWBIE);
      expect(this.messages).to.have.length(0);
      expect(JSON.parse(stateRows(this)[0].value).rank).to.equal('Newbie');
    },
  }),

  createModuleTest({
    name: 'Offline players are skipped by the cron job',
    module: MODULE,
    userConfig: { ranks: RANKS },
    settings: ECONOMY_ON,
    player: { online: false },
    setup: function () {
      (this.pog as unknown as Pog).playtimeSeconds = 100 * HOUR;
    },
    test: async function () {
      const result = await this.runCronJob('check-ranks');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.player.playerControllerAssignRole).to.not.have.been.called;
      expect(stateRows(this)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'Economy disabled: promotes but keeps the reward for later',
    module: MODULE,
    userConfig: { ranks: RANKS },
    settings: { economyEnabled: 'false' },
    setup: function () {
      (this.pog as unknown as Pog).playtimeSeconds = 11 * HOUR;
    },
    test: async function () {
      const result = await this.runCronJob('check-ranks');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);
      expect(this.pms()).to.have.length(1);
      const state = JSON.parse(stateRows(this)[0].value);
      expect(state.rank).to.equal('Regular');
      expect(state.rewarded).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Global playtime source uses playtime across all servers',
    module: MODULE,
    userConfig: { ranks: RANKS, playtimeSource: 'global', roleScope: 'global', broadcastMessage: '' },
    settings: ECONOMY_ON,
    setup: function () {
      (this.pog as unknown as Pog).playtimeSeconds = 1 * HOUR;
      (this.player as unknown as { playtimeSeconds: number }).playtimeSeconds = 250 * HOUR;
    },
    test: async function () {
      const result = await this.runCronJob('check-ranks');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      // Global scope: no gameServerId on the assignment.
      expect(this.client.stubs.player.playerControllerAssignRole).to.have.been.calledOnceWith(this.pog.playerId, ROLE_LEGEND, {});
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(2600);
      expect(this.messages.filter((m) => m.recipientGameId === undefined)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'rank shows current rank, hours and time to next rank',
    module: MODULE,
    userConfig: { ranks: RANKS, rewardMessage: '' },
    settings: ECONOMY_ON,
    player: { name: 'Carol' },
    setup: function () {
      const pog = this.pog as unknown as Pog;
      pog.playtimeSeconds = 12.5 * HOUR;
      giveRole(pog, ROLE_REGULAR, 'Regular');
    },
    variables: [],
    test: async function () {
      const result = await this.runCommand('rank');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const pms = this.pms();
      // First run also promotes (state was empty), then the status line.
      expect(pms[pms.length - 1]).to.equal('Rank: Regular (12.5 h played). Next: Veteran in 37h 30m.');

      const again = await this.runCommand('rank');
      expect(again.success, JSON.stringify(again.logs)).to.be.true;
      expect(this.pms().slice(pms.length)).to.deep.equal(['Rank: Regular (12.5 h played). Next: Veteran in 37h 30m.']);
    },
  }),

  createModuleTest({
    name: 'rank at the top of the ladder says so',
    module: MODULE,
    userConfig: { ranks: RANKS, broadcastMessage: '', rewardMessage: '' },
    settings: ECONOMY_ON,
    setup: function () {
      const pog = this.pog as unknown as Pog;
      pog.playtimeSeconds = 300 * HOUR;
      giveRole(pog, ROLE_LEGEND, 'Legend');
      this.variables.insert({
        key: 'playtime_rank_state',
        value: JSON.stringify({ rank: 'Legend', rewarded: ['Regular', 'Veteran', 'Legend'] }),
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
        playerId: this.pog.playerId,
      });
    },
    test: async function () {
      const result = await this.runCommand('rank');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Rank: Legend (300 h played). You have reached the highest rank!']);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);
    },
  }),

  createModuleTest({
    name: 'rank with an empty ladder explains it',
    module: MODULE,
    userConfig: { ranks: [] },
    settings: ECONOMY_ON,
    test: async function () {
      const result = await this.runCommand('rank');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['No playtime ranks are configured on this server.']);
    },
  }),

  createModuleTest({
    name: 'ranks lists the ladder in order with rewards',
    module: MODULE,
    userConfig: { ranks: [RANKS[2], RANKS[0], RANKS[1]] },
    settings: ECONOMY_ON,
    test: async function () {
      const result = await this.runCommand('ranks');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Playtime ranks: Newbie: 0 h > Regular: 10 h (+100 test coin) > Veteran: 50 h (+500 test coin). Type /rank to see your progress.',
      ]);
    },
  }),

  createModuleTest({
    name: 'rankcheck promotes the target and reports to the admin',
    module: MODULE,
    userConfig: { ranks: RANKS, broadcastMessage: '' },
    settings: ECONOMY_ON,
    player: { name: 'Admin' },
    otherPlayers: [{ name: 'Dave' }],
    setup: function () {
      (this.otherPlayers[0].pog as unknown as Pog).playtimeSeconds = 10 * HOUR;
    },
    test: async function () {
      const target = this.otherPlayers[0].pog;
      const result = await this.runCommand('rankcheck', { player: target });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;

      expect(this.client.stubs.player.playerControllerAssignRole).to.have.been.calledOnceWith(target.playerId, ROLE_REGULAR);
      expect(this.currency.balanceOf(target.playerId)).to.equal(100);
      expect(this.pms()).to.deep.equal([
        'Dave: Rank: Regular (10 h played). Next: Veteran in 40h. Changes: promoted to Regular, role added: Regular, paid 100 test coin.',
      ]);
      expect(this.client.pmsTo(target.gameId)).to.deep.equal([
        'Congratulations Dave! You reached the rank Regular after 10 h of playtime. Type /rank to see your progress.',
        'You received 100 test coin for reaching Regular!',
      ]);
    },
  }),

  createModuleTest({
    name: 'rankcheck on an up-to-date player reports no changes',
    module: MODULE,
    userConfig: { ranks: RANKS },
    settings: ECONOMY_ON,
    otherPlayers: [{ name: 'Eve' }],
    setup: function () {
      const pog = this.otherPlayers[0].pog as unknown as Pog;
      pog.playtimeSeconds = 0.5 * HOUR;
      giveRole(pog, ROLE_NEWBIE, 'Newbie');
      this.variables.insert({
        key: 'playtime_rank_state',
        value: JSON.stringify({ rank: 'Newbie', rewarded: [] }),
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
        playerId: pog.playerId,
      });
    },
    test: async function () {
      const result = await this.runCommand('rankcheck', { player: this.otherPlayers[0].pog });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Eve: Rank: Newbie (0.5 h played). Next: Regular in 9h 30m. No changes needed.']);
    },
  }),
];

describe('playtime-ranks (module-VM)', function () {
  tests.forEach((test) => {
    test.run();
  });
});
