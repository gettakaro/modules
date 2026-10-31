import { describe } from 'node:test';
import { expect } from '../../../../test/support/expect.ts';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'checkPermission is scoped to the executing Module (module-VM)';

describe(group, () => {
  const helpTests = [
    createModuleTest({
      name: "/help lists another Module's command for a grant on that Module's permission",
      module: MODULE,
      alsoInstalled: [{ module: new URL('../../../teleports/', import.meta.url) }],
      permissions: [{ permission: 'TELEPORTS_USE', module: 'teleports' }],
      test: async function () {
        const result = await this.runCommand('help');
        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(this.pms().some((msg) => msg.startsWith('settp:'))).to.be.true;
      },
    }),
    createModuleTest({
      name: "/help hides another Module's command for a same-named grant of a different Module",
      module: MODULE,
      alsoInstalled: [{ module: new URL('../../../teleports/', import.meta.url) }],
      permissions: [{ permission: 'TELEPORTS_USE' }],
      test: async function () {
        const result = await this.runCommand('help');
        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(this.pms().some((msg) => msg.startsWith('settp:'))).to.be.false;
        expect(this.pms().some((msg) => msg.startsWith('ping:'))).to.be.true;
      },
    }),
  ];
  helpTests.forEach((test) => test.run());
});
