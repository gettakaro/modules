import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'EconomyUtils (module-VM)';

// Chat delivery happens outside the VM, so error cases assert `this.userError(result)`.

const TRANSFER_AMOUNT = 500;

const tests = [
  createModuleTest({
    name: 'Should return friendly user error when not enough currency',
    module: MODULE,
    permissions: 'ROOT',
    player: { name: 'Sender' },
    otherPlayers: [{ name: 'Receiver' }],
    // No `currency` option: both players default to 0, below TRANSFER_AMOUNT, so the real
    // `CurrencyLedger.deduct` rejection path runs end to end rather than a stubbed one.
    test: async function () {
      const receiver = this.otherPlayers[0];

      // The POG, not the player: `transfer.js` reads POG row ids, which the transact endpoint resolves.
      const result = await this.runCommand('transfer', { receiver: receiver.pog, amount: TRANSFER_AMOUNT });

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(
        `Failed to transfer ${TRANSFER_AMOUNT} test coin to Receiver. Are you sure you have enough balance?`,
      );

      // `transfer.js` catches everything into the same message, so both facts below are needed
      // to tell an insufficient-funds rejection from a harness failing to resolve the players.
      const transact = this.client.stubs.playerOnGameserver.playerOnGameServerControllerTransactBetweenPlayers;
      expect(transact).to.have.been.calledOnce;
      expect(transact?.firstCall.args[0]).to.equal(this.gameServerId);
      expect(transact?.firstCall.args[1]).to.equal(this.pog.id);
      expect(transact?.firstCall.args[2]).to.equal(receiver.pog.id);
      // The fake is async, so it rejects rather than throws; read the rejection off the promise.
      const rejection = await (transact!.firstCall.returnValue as Promise<unknown>).catch((error: unknown) => error);
      expect((rejection as Error).name).to.equal('InsufficientFundsError');

      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);
      expect(this.currency.balanceOf(receiver.pog.playerId)).to.equal(0);
      expect(this.client.stubs.gameserver.gameServerControllerSendMessage).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'Should return no pending transfers when there are none',
    module: MODULE,
    permissions: 'ROOT',
    userConfig: { pendingAmount: 100 },
    test: async function () {
      // Unseeded: `confirmTransfer.js` finds nothing under its scope filter, takes the rejection branch.
      expect(this.variables.all).to.have.length(0);

      const result = await this.runCommand('confirmTransfer');

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You have no pending transfer.');
      // The guard is before the delete and the transact, so nothing was written or removed.
      expect(this.variables.all).to.have.length(0);
      expect(this.client.stubs.playerOnGameserver.playerOnGameServerControllerTransactBetweenPlayers).to.not.have.been
        .called;
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
