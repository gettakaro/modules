import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'shopActions - grantRole (module-VM)';

const ROLE_ID = '4c1d7e52-93aa-4f08-8b6e-2d5a0f9c1e37';

const tests = [
  createModuleTest({
    name: 'Grants the role the listing names',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      const result = await this.runShopAction('grantRole', {
        triggerEvent: 'orderClaimed',
        shopActionArguments: { roleId: ROLE_ID },
      });

      expect(result.success).to.be.true;
      expect(this.client.stubs.player.playerControllerAssignRole).to.have.been.calledOnce;
      expect(this.client.stubs.player.playerControllerAssignRole?.firstCall.args[1]).to.equal(ROLE_ID);
    },
  }),

  createModuleTest({
    name: 'A listing without a role fails before any API call',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      const result = await this.runShopAction('grantRole', { triggerEvent: 'orderClaimed' });

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('No role is set on this listing for the grantRole shop action.');
      expect(this.client.stubs.player.playerControllerAssignRole).to.not.have.been.called;
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
