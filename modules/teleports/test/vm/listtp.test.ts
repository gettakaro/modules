import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'Teleports suite (module-VM)';

const tests = [
  createModuleTest({
    name: 'Can list teleports with /tplist',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      for (const name of ['test0', 'test1', 'test2']) {
        const set = await this.runCommand('settp', { tp: name });
        expect(set.success, JSON.stringify(set.logs)).to.be.true;
      }

      const result = await this.runCommand('tplist');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const { positionX: x, positionY: y, positionZ: z } = this.pog;
      // tplist.js appends a `(public)` marker with an unconditional separating space, so a private
      // teleport's line ends in a trailing space. The integration case matched with a regex and
      // could not see it; asserting the exact string is the point of this tier.
      expect(this.pms().slice(3)).to.deep.equal([
        'You have 3 teleports available',
        `test0: (${x},${y},${z}) `,
        `test1: (${x},${y},${z}) `,
        `test2: (${x},${y},${z}) `,
      ]);
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
