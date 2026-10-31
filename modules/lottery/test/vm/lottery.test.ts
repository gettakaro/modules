import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'lottery suite (module-VM)';

// Chat delivery happens outside the VM, so error cases assert `this.userError(result)`.

const TICKET_KEY = 'lottery_tickets_bought';
const TICKET_COST = 50;
/** Decoy scope values for "Can view lottery tickets" — one per scope column `viewTickets.js` filters on. */
const OTHER_MODULE_ID = 'b7c3e9a1-4f28-4d6b-9a05-2e8c7d1f3b60';
const OTHER_GAME_SERVER_ID = '3a9f5d84-6c17-4e2a-8b13-5f0d9c4a7e21';
const OTHER_KEY = 'lottery_tickets_refunded';

const tests = [
  createModuleTest({
    name: 'Cannot buy 0 lottery tickets',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      const result = await this.runCommand('buyTicket', { amount: 0 });

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You must buy at least 1 ticket.');
      // `buyTicket.js` guards first, so nothing was persisted or charged.
      expect(this.variables.all).to.have.length(0);
      expect(this.client.stubs.playerOnGameserver.playerOnGameServerControllerDeductCurrency).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'Can view lottery tickets',
    module: MODULE,
    permissions: 'ROOT',
    // `buyTicket.js` reads the price off `systemConfig.commands.buyTicket.cost`; harness default is 0.
    systemConfig: { commands: { buyTicket: { cost: TICKET_COST } } },
    currency: 1000,
    otherPlayers: [{ name: 'Other player' }],
    setup: async function () {
      // One decoy per `viewTickets.js` filter column, so dropping any filter changes the count.
      const decoy = { value: JSON.stringify({ amount: 10 }) };
      this.variables.insert({
        ...decoy,
        key: TICKET_KEY,
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
        playerId: this.otherPlayers[0].pog.playerId,
      });
      this.variables.insert({
        ...decoy,
        key: TICKET_KEY,
        gameServerId: this.gameServerId,
        moduleId: OTHER_MODULE_ID,
        playerId: this.pog.playerId,
      });
      this.variables.insert({
        ...decoy,
        key: OTHER_KEY,
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
        playerId: this.pog.playerId,
      });
      this.variables.insert({
        ...decoy,
        key: TICKET_KEY,
        gameServerId: OTHER_GAME_SERVER_ID,
        moduleId: this.moduleId,
        playerId: this.pog.playerId,
      });
    },
    test: async function () {
      const wantAmount = 10;

      const boughtMessage = `You have successfully bought ${wantAmount} tickets for ${wantAmount * TICKET_COST} test coin. Good luck!`;

      const buy = await this.runCommand('buyTicket', { amount: wantAmount });
      expect(buy.success, JSON.stringify(buy.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([boughtMessage]);

      // Real variable store; matched on all four scope columns since decoys collide on three of them.
      const own = this.variables.all.filter(
        (row) =>
          row.key === TICKET_KEY &&
          row.gameServerId === this.gameServerId &&
          row.moduleId === this.moduleId &&
          row.playerId === this.pog.playerId,
      );
      expect(own).to.have.length(1);
      expect(JSON.parse(own[0].value).amount).to.equal(wantAmount);
      // Total is pinned too: four decoys plus the one row `buyTicket.js` wrote, catching a stray extra write.
      expect(this.variables.all).to.have.length(5);

      const view = await this.runCommand('viewTickets');
      expect(view.success, JSON.stringify(view.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([boughtMessage, `You have bought ${wantAmount} tickets.`]);

      // Pins `buyTicket.js`'s `price - 1` deduction — a real overcharge (gettakaro/takaro#3315) atop the outside-VM cost charge.
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(1000 - (wantAmount * TICKET_COST - 1));
    },
  }),

  createModuleTest({
    name: 'If no players joined, the lottery is cancelled',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      const result = await this.runCronJob('drawLottery');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      // Broadcast, not a pm: `drawLottery.js` sends with no `recipient`, so `this.pms()` is empty.
      expect(this.messages).to.have.length(1);
      expect(this.messages[0].message).to.equal('No one has bought any tickets. The lottery has been cancelled.');
      expect(this.messages[0].recipientGameId).to.be.undefined;
      expect(this.pms()).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Can view next lottery draw',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      const result = await this.runCommand('nextDraw');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      // Only the prefix is assertable: `nextDraw.js`'s in-VM clock and the host-clock `nextCronJobRun` can't both be frozen.
      expect(this.pms()).to.have.length(1);
      expect(this.pms()[0]).to.contain('The next lottery draw is in');
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
