import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'Teleports suite (module-VM)';

const tests = [
  createModuleTest({
    name: 'Can set a teleport with /settp',
    module: MODULE,
    // ROOT deliberately. Under ROOT `checkPermission` returns the boolean `true`, so
    // `hasPermission.count` is undefined and the max-teleports comparison in settp.js is always
    // false — that IS how ROOT gets unlimited teleports. A cap test needs a counted permission
    // instead; Takaro's teleports integration tests assert the cap.
    permissions: 'ROOT',
    test: async function () {
      const result = await this.runCommand('settp', { tp: 'test' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Teleport test set.']);

      const stored = this.variables.all;
      expect(stored).to.have.length(1);
      expect(stored[0].key).to.equal('tp_test');
      expect(stored[0].playerId).to.equal(this.pog.playerId);
      expect(stored[0].moduleId).to.equal(this.moduleId);
      expect(JSON.parse(stored[0].value)).to.deep.equal({
        name: 'test',
        x: this.pog.positionX,
        y: this.pog.positionY,
        z: this.pog.positionZ,
        dimension: this.pog.dimension,
      });
    },
  }),

  createModuleTest({
    name: 'Shows an error when setting a teleport with an existing name',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      const first = await this.runCommand('settp', { tp: 'test' });
      expect(first.success, JSON.stringify(first.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Teleport test set.']);

      const second = await this.runCommand('settp', { tp: 'test' });

      expect(second.success).to.be.false;
      // The prefix comes from the commandPrefix setting, which settp.js reads through the client.
      expect(this.userError(second)).to.equal('Teleport test already exists, use /deletetp test to delete it.');
      expect(this.variables.all).to.have.length(1);
    },
  }),

  createModuleTest({
    name: 'Shows an error when removing a non-existing teleport',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      const result = await this.runCommand('deletetp', { tp: 'test' });

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('Teleport test does not exist.');
      expect(this.client.stubs.variable.variableControllerDelete).to.not.have.been.called;
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
