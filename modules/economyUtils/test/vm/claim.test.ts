import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, paginated, single } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'EconomyUtils:Shop:Claim (module-VM)';

// `claim.js` needs `data.user`; without this fixture the case would pass on the wrong branch.
const tests = [
  createModuleTest({
    name: 'Shows a friendly error when there are no pending orders',
    module: MODULE,
    permissions: 'ROOT',
    // No `userId`: read back below through `this.user`, which is what the harness exposes it for.
    user: {},
    test: async function () {
      const userId = this.user?.id;
      expect(userId, 'the `user` fixture must put a linked user on the payload').to.be.a('string');

      this.client.stubs.shopOrder.shopOrderControllerSearch?.callsFake(async () => paginated([]));

      const result = await this.runCommand('claim');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['You have no pending orders.']);

      // Checks the query, not just the message: unclaimed/FAILED-delivery orders scoped to this user+server.
      const search = this.client.stubs.shopOrder.shopOrderControllerSearch;
      expect(search).to.have.been.calledTwice;
      const scope = { userId: [userId], gameServerId: [this.gameServerId] };
      expect(search?.firstCall.args[0]).to.deep.equal({
        filters: { ...scope, status: ['PAID'] },
        sortBy: 'createdAt',
        sortDirection: 'asc',
      });
      expect(search?.secondCall.args[0]).to.deep.equal({
        filters: { ...scope, status: ['COMPLETED'], deliveryStatus: ['FAILED'] },
        sortBy: 'createdAt',
        sortDirection: 'asc',
      });

      expect(this.client.stubs.shopOrder.shopOrderControllerClaim).to.not.have.been.called;
    },
  }),
  createModuleTest({
    name: 'Claims a COMPLETED order whose delivery FAILED and says when it failed again',
    module: MODULE,
    permissions: 'ROOT',
    user: {},
    test: async function () {
      const failedId = 'c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
      this.client.stubs.shopOrder.shopOrderControllerSearch?.callsFake(async (query) =>
        query?.filters?.status?.[0] === 'COMPLETED'
          ? paginated([
              { id: failedId, status: 'COMPLETED', deliveryStatus: 'FAILED', createdAt: '2026-01-01T00:00:00Z' },
            ])
          : paginated([]),
      );
      this.client.stubs.shopOrder.shopOrderControllerClaim?.callsFake(async () =>
        single({ id: failedId, status: 'COMPLETED', deliveryStatus: 'FAILED' }),
      );

      const result = await this.runCommand('claim');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.shopOrder.shopOrderControllerClaim).to.have.been.calledOnceWith(failedId);
      expect(this.pms()).to.deep.equal(['The items of an order could not be handed over. Use /claim to try again.']);
    },
  }),

  createModuleTest({
    name: 'Claims a PAID order before an older FAILED one, and flags an UNKNOWN outcome',
    module: MODULE,
    permissions: 'ROOT',
    user: {},
    test: async function () {
      const olderFailed = 'd1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
      const newerPaid = 'e1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
      this.client.stubs.shopOrder.shopOrderControllerSearch?.callsFake(async (query) =>
        query?.filters?.status?.[0] === 'COMPLETED'
          ? paginated([
              { id: olderFailed, status: 'COMPLETED', deliveryStatus: 'FAILED', createdAt: '2026-01-01T00:00:00Z' },
            ])
          : paginated([{ id: newerPaid, status: 'PAID', createdAt: '2026-02-01T00:00:00Z' }]),
      );
      this.client.stubs.shopOrder.shopOrderControllerClaim?.callsFake(async (id: string) =>
        single({ id, status: 'COMPLETED', deliveryStatus: 'UNKNOWN' }),
      );

      const result = await this.runCommand('claim', { all: false });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.shopOrder.shopOrderControllerClaim).to.have.been.calledOnceWith(newerPaid);
      expect(this.pms()).to.deep.equal(['The delivery of an order could not be confirmed. Ask an admin to check it.']);
    },
  }),
  createModuleTest({
    name: 'Skips a FAILED order that can no longer be claimed and claims the next one',
    module: MODULE,
    permissions: 'ROOT',
    user: {},
    test: async function () {
      const dead = 'f1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
      const recoverable = 'a2d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
      this.client.stubs.shopOrder.shopOrderControllerSearch?.callsFake(async (query) =>
        query?.filters?.status?.[0] === 'COMPLETED'
          ? paginated([
              { id: dead, status: 'COMPLETED', deliveryStatus: 'FAILED', createdAt: '2026-01-01T00:00:00Z' },
              { id: recoverable, status: 'COMPLETED', deliveryStatus: 'FAILED', createdAt: '2026-02-01T00:00:00Z' },
            ])
          : paginated([]),
      );
      this.client.stubs.shopOrder.shopOrderControllerClaim?.callsFake(async (id: string) => {
        if (id === dead) {
          throw new Error('Request failed with status code 400');
        }
        return single({ id, status: 'COMPLETED', deliveryStatus: 'DELIVERED' });
      });

      const result = await this.runCommand('claim', { all: false });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const claim = this.client.stubs.shopOrder.shopOrderControllerClaim;
      expect(claim?.getCalls().map((call) => call.args[0])).to.deep.equal([dead, recoverable]);
      expect(this.pms()).to.deep.equal([]);
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
