import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';
import type { ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'High Ping Kicker (module-VM)';

const CRON_JOB = 'Ping check';
const VARIABLE_KEY = 'highPingKicker:warnings';

/**
 * `Ping check.js` resolves the player by `steamId`; a fixture without one makes the search
 * unfiltered, so every per-player assertion below would be about fixture ordering, not the module.
 */
const STEAM = {
  acting: '76561198000000001',
  second: '76561198000000002',
  third: '76561198000000003',
};

/** The messages sent to one player's gameId, so a multi-player run is asserted per recipient. */
function messagesTo(test: ModuleTest, gameId: string): string[] {
  return test.messages.filter((message) => message.recipientGameId === gameId).map((message) => message.message);
}

const tests = [
  createModuleTest({
    name: 'Should warn players with high ping using default configuration',
    module: MODULE,
    player: { ping: 250, steamId: STEAM.acting },
    test: async function () {
      const result = await this.runCronJob(CRON_JOB);

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Your ping (250) is too high. Warning 1/3']);
      expect(this.client.stubs.gameserver.gameServerControllerKickPlayer).to.not.have.been.called;

      // The counter's SCOPE: no gameServerId/moduleId, so one counter is shared domain-wide per player.
      expect(this.variables.all).to.have.length(1);
      const counter = this.variables.all[0];
      expect(counter.key).to.equal(VARIABLE_KEY);
      expect(counter.value).to.equal('1');
      expect(counter.playerId).to.equal(this.pog.playerId);
      expect(counter.gameServerId).to.be.undefined;
      expect(counter.moduleId).to.be.undefined;
    },
  }),

  createModuleTest({
    name: 'Should not warn players with ping below threshold',
    module: MODULE,
    player: { ping: 50, steamId: STEAM.acting },
    test: async function () {
      const result = await this.runCronJob(CRON_JOB);

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.deep.equal([]);
      // Below the threshold the module never enters the branch at all, so no counter is written.
      expect(this.variables.all).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Should handle multiple players with different ping values correctly',
    module: MODULE,
    player: { name: 'Above', ping: 250, steamId: STEAM.acting },
    otherPlayers: [
      { name: 'Below', ping: 50, steamId: STEAM.second },
      { name: 'Also above', ping: 300, steamId: STEAM.third },
    ],
    test: async function () {
      const result = await this.runCronJob(CRON_JOB);

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.have.length(2);
      // Per recipient, because the whole subject is which player each warning went to.
      expect(this.pms()).to.deep.equal(['Your ping (250) is too high. Warning 1/3']);
      expect(messagesTo(this, this.otherPlayers[0].pog.gameId)).to.deep.equal([]);
      expect(messagesTo(this, this.otherPlayers[1].pog.gameId)).to.deep.equal([
        'Your ping (300) is too high. Warning 1/3',
      ]);
      // One counter each for the two players over the threshold, and none for the third.
      expect(
        this.variables.all
          .map((row) => row.playerId)
          .sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)),
      ).to.deep.equal(
        [this.pog.playerId, this.otherPlayers[1].pog.playerId].sort((a, b) =>
          String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
        ),
      );
    },
  }),

  createModuleTest({
    name: 'Should handle ping exactly at threshold (boundary condition)',
    module: MODULE,
    // The comparison is a strict `>`, so the default threshold of 200 does not warn at 200.
    player: { ping: 200, steamId: STEAM.acting },
    test: async function () {
      const result = await this.runCronJob(CRON_JOB);

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.deep.equal([]);
      expect(this.variables.all).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Should warn for ping just above threshold (boundary condition)',
    module: MODULE,
    player: { ping: 201, steamId: STEAM.acting },
    test: async function () {
      const result = await this.runCronJob(CRON_JOB);

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Your ping (201) is too high. Warning 1/3']);
    },
  }),

  createModuleTest({
    name: 'Should handle very high ping values correctly',
    module: MODULE,
    player: { ping: 9999, steamId: STEAM.acting },
    test: async function () {
      const result = await this.runCronJob(CRON_JOB);

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Your ping (9999) is too high. Warning 1/3']);
    },
  }),

  createModuleTest({
    name: 'Should handle extreme configuration values',
    module: MODULE,
    userConfig: { pingThreshold: 1, warningsBeforeKick: 10 },
    player: { ping: 50, steamId: STEAM.acting },
    test: async function () {
      const result = await this.runCronJob(CRON_JOB);

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      // Both configured numbers reach the message: threshold via the branch, count via the `1/10` format.
      expect(this.pms()).to.deep.equal(['Your ping (50) is too high. Warning 1/10']);
      expect(this.client.stubs.gameserver.gameServerControllerKickPlayer).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'Should handle concurrent ping changes during warning period',
    module: MODULE,
    userConfig: { pingThreshold: 200, warningsBeforeKick: 2 },
    player: { name: 'First', ping: 250, steamId: STEAM.acting },
    otherPlayers: [
      { name: 'Second', ping: 260, steamId: STEAM.second },
      { name: 'Third', ping: 270, steamId: STEAM.third },
    ],
    test: async function () {
      const result = await this.runCronJob(CRON_JOB);

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      // Each player gets its own counter; nobody is kicked on run 1 since no counter existed yet.
      expect(this.pms()).to.deep.equal(['Your ping (250) is too high. Warning 1/2']);
      expect(messagesTo(this, this.otherPlayers[0].pog.gameId)).to.deep.equal([
        'Your ping (260) is too high. Warning 1/2',
      ]);
      expect(messagesTo(this, this.otherPlayers[1].pog.gameId)).to.deep.equal([
        'Your ping (270) is too high. Warning 1/2',
      ]);
      expect(this.variables.all).to.have.length(3);
      expect(this.client.stubs.gameserver.gameServerControllerKickPlayer).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'Should handle player with missing ping data gracefully',
    module: MODULE,
    // No `ping` at all: dropped like the real gameserver view, so module code sees `undefined > 200`.
    player: { steamId: STEAM.acting },
    test: async function () {
      const result = await this.runCronJob(CRON_JOB);

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.deep.equal([]);
      expect(this.variables.all).to.deep.equal([]);
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
