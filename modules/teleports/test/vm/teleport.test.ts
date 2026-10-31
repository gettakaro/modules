import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'Teleports suite (module-VM)';

// Chat delivery happens outside the VM, so these assert the function failure directly.
// The VM gets its own `Date`, so clock-sensitive cases pass `now` explicitly.
const FROZEN = new Date('2024-06-01T12:00:00.000Z');

const tests = [
  createModuleTest({
    name: 'Can teleport with /tp',
    module: MODULE,
    permissions: 'ROOT',
    now: FROZEN,
    test: async function () {
      const set = await this.runCommand('settp', { tp: 'test' });
      expect(set.success, JSON.stringify(set.logs)).to.be.true;

      const result = await this.runCommand('teleport', { tp: 'test' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Teleport test set.', 'Teleported to test.']);

      // The default userConfig timeout is 1000ms, so teleport.js takes its timeout branch and
      // persists a `lastExecuted` marker alongside the teleport itself.
      expect(this.variables.all.map((row) => row.key).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).to.deep.equal([
        'lastExecuted',
        'tp_test',
      ]);

      const teleportPlayer = this.client.stubs.gameserver.gameServerControllerTeleportPlayer;
      expect(teleportPlayer).to.have.been.calledOnce;
      expect(teleportPlayer?.firstCall.args[0]).to.equal(this.gameServerId);
      expect(teleportPlayer?.firstCall.args[1]).to.equal(this.pog.playerId);
      expect(teleportPlayer?.firstCall.args[2]).to.deep.equal({
        x: this.pog.positionX,
        y: this.pog.positionY,
        z: this.pog.positionZ,
        dimension: this.pog.dimension,
      });
    },
  }),

  createModuleTest({
    name: 'Shows an error when teleporting to a non-existing teleport',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      const result = await this.runCommand('teleport', { tp: 'test' });

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('Teleport test does not exist.');
      expect(this.client.stubs.gameserver.gameServerControllerTeleportPlayer).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'Times out when teleporting faster than set timeout',
    module: MODULE,
    permissions: 'ROOT',
    userConfig: { timeout: 5000 },
    // Frozen so the second /tp sees a zero elapsed time, unambiguously inside the 5s window.
    now: FROZEN,
    test: async function () {
      const set = await this.runCommand('settp', { tp: 'test' });
      expect(set.success, JSON.stringify(set.logs)).to.be.true;

      const first = await this.runCommand('teleport', { tp: 'test' });
      expect(first.success, JSON.stringify(first.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Teleport test set.', 'Teleported to test.']);

      const second = await this.runCommand('teleport', { tp: 'test' });

      expect(second.success).to.be.false;
      expect(this.userError(second)).to.equal('You cannot teleport yet. Please wait before trying again.');
      // The denied attempt must not reach the gameserver.
      expect(this.client.stubs.gameserver.gameServerControllerTeleportPlayer).to.have.been.calledOnce;
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
