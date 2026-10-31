import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'Teleports suite (module-VM)';

// Chat delivery happens outside the VM, so these assert the function failure directly.

const tests = [
  createModuleTest({
    name: 'When configured to not allow public teleports, creating public teleports is not allowed',
    module: MODULE,
    permissions: 'ROOT',
    userConfig: { allowPublicTeleports: false, timeout: 0 },
    test: async function () {
      const set = await this.runCommand('settp', { tp: 'test' });
      expect(set.success, JSON.stringify(set.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Teleport test set.']);

      const result = await this.runCommand('setpublic', { tp: 'test' });

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('Public teleports are disabled.');
      // The config gate is before any store write, so the teleport is still private.
      expect(this.variables.all.map((row) => row.key)).to.deep.equal(['tp_test']);
    },
  }),

  createModuleTest({
    name: 'Prohibits players from settings more public teleports than their role allows',
    module: MODULE,
    permissions: [
      // Counted, not ROOT: `checkPermission` returns the boolean `true` for a ROOT player, so
      // `hasPermission.count` is undefined and setpublic.js's `>=` compare can never be true.
      { permission: 'TELEPORTS_CREATE_PUBLIC', count: 3 },
      { permission: 'TELEPORTS_USE', count: 5 },
    ],
    userConfig: { allowPublicTeleports: true, timeout: 0 },
    test: async function () {
      for (const name of ['test0', 'test1', 'test2', 'test3']) {
        const set = await this.runCommand('settp', { tp: name });
        expect(set.success, JSON.stringify(set.logs)).to.be.true;
      }

      for (const name of ['test0', 'test1', 'test2']) {
        const pub = await this.runCommand('setpublic', { tp: name });
        expect(pub.success, JSON.stringify(pub.logs)).to.be.true;
      }

      expect(this.variables.all.filter((row) => row.key.startsWith('pubtp_'))).to.have.length(3);

      // `test3` was never set: a name that doesn't exist would fail the "no teleport" check too,
      // making it ambiguous which guard fired.
      const result = await this.runCommand('setpublic', { tp: 'test3' });

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(
        'You have reached the maximum number of public teleports for your role, maximum allowed is 3',
      );
      expect(this.variables.all.filter((row) => row.key.startsWith('pubtp_'))).to.have.length(3);
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
