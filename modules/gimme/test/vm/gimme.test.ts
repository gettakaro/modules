import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'gimme suite (module-VM)';

const tests = [
  createModuleTest({
    name: 'Can give an item to a player',
    module: MODULE,
    userConfig: {
      items: [{ item: 'item-1', amount: 3, quality: '2' }],
      commands: [],
    },
    // Pins the draw to the single configured item. `Math.random` inside the VM is the context's
    // own copy, so this only works through the `random` option.
    random: 0,
    test: async function () {
      this.client.stubs.item.itemControllerFindOne?.resolves({
        data: { data: { id: 'item-1', name: 'Stone axe', code: 'stoneAxe' } },
      } as never);

      const result = await this.runCommand('gimme');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerGiveItem).to.have.been.calledOnceWith(
        this.gameServerId,
        this.player.id,
        { name: 'item-1', amount: 3, quality: '2' },
      );
      expect(this.pms()).to.deep.equal(['You received 3x Stone axe!']);
    },
  }),

  createModuleTest({
    name: 'When no items or commands configured, displays an error',
    module: MODULE,
    userConfig: { items: [], commands: [] },
    test: async function () {
      const result = await this.runCommand('gimme');

      expect(result.success).to.be.false;
      // Not "the player received this chat message": Takaro delivers a TakaroUserError outside
      // the VM. See `userError` in the @takaro/module-test README.
      expect(this.userError(result)).to.match(/No items or commands configured/);
      expect(this.pms()).to.deep.equal([]);
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
