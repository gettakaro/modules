import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, paginated, single } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'EconomyUtils:Shop:Browse (module-VM)';

/** The one line a buy prints when the order is paid for but not handed over. */
const PENDING_PM =
  'Your purchase of Test item went through, but it could not be handed over yet. Use /claim once you are in game to receive it.';

// Errors assert `this.userError(result)`: chat delivery happens outside the VM. Every case states the chat line typed.

const stoneListing = {
  id: '5d9c1f70-2b3a-4c8e-8f21-6a7b9c0d1e2f',
  name: 'Test item',
  price: 100,
  items: [
    {
      amount: 1,
      item: { name: 'Stone', description: 'Stone can get you stoned' },
    },
  ],
};

const woodListing = {
  id: '8e2a4b61-9c7d-4f30-b5a8-3d1e6f2c0a94',
  name: 'Wood item',
  price: 33,
  items: [{ amount: 1, item: { name: 'Wood', description: 'Wood is good' } }],
};

const tests = [
  createModuleTest({
    name: 'Calling /shop without arguments displays help information',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      const result = await this.runCommand('shop');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'This command allows you to browse the shop and view available items.',
        'Usage: /shop [page] [item] [action]',
        '/shop 2 - View the second page of shop items',
        '/shop 1 3 - View details about the third item on the first page',
        '/shop 1 3 buy - Purchase the third item on the first page',
      ]);
      expect(this.client.stubs.shopListing.shopListingControllerSearch).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'Can show details about an item',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      // ONE listing: `shop.js` indexes positionally, so more would depend on the fake's collation.
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () => paginated([stoneListing]));

      const result = await this.runCommand('shop', { page: 1, item: 1, action: 'none' }, { chatMessage: '/shop 1 1' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Listing Test item - 100 test coin',
        '- 1x Stone.  Description: Stone can get you stoned', // Two spaces: no quality (shop.js).
      ]);

      // Asserted whole: the fake discards the query, so paging/scope/`draft: false` are invisible above.
      const search = this.client.stubs.shopListing.shopListingControllerSearch;
      expect(search).to.have.been.calledOnce;
      expect(search?.firstCall.args[0]).to.deep.equal({
        limit: 5,
        page: 0,
        sortBy: 'name',
        sortDirection: 'asc',
        filters: {
          gameServerId: [this.gameServerId],
          draft: false,
        },
      });
    },
  }),

  createModuleTest({
    name: 'Shows an error when requesting details for an invalid item',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      // Two listings: the error message embeds the count, chosen deliberately rather than inherited.
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () =>
        paginated([stoneListing, woodListing]),
      );

      const result = await this.runCommand('shop', { page: 1, item: 5, action: 'none' }, { chatMessage: '/shop 1 5' });

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(
        'Item not found. Please select an item from the list, valid options are 1-2.',
      );
      expect(this.client.stubs.shopOrder.shopOrderControllerCreate).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'Buying an instant listing does not attempt a second claim',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () => paginated([stoneListing]));
      this.client.stubs.shopOrder.shopOrderControllerCreate?.callsFake(async () =>
        single({ id: 'c9d2b0fe-3a4b-4d1e-8c07-5f6a7b8c9d01', status: 'COMPLETED', deliveryStatus: 'DELIVERED' }),
      );

      const result = await this.runCommand(
        'shop',
        { page: 1, item: 1, action: 'buy' },
        { chatMessage: '/shop 1 1 buy' },
      );

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['You have purchased Test item for 100 test coin.']);
      // COMPLETED listings must not be claimed again — claiming would throw (gettakaro/takaro#2526).
      expect(this.client.stubs.shopOrder.shopOrderControllerClaim).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'Buying a claim listing still claims',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      const orderId = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () => paginated([stoneListing]));
      this.client.stubs.shopOrder.shopOrderControllerCreate?.callsFake(async () =>
        single({ id: orderId, status: 'PAID' }),
      );
      this.client.stubs.shopOrder.shopOrderControllerClaim?.callsFake(async () =>
        single({ id: orderId, status: 'COMPLETED', deliveryStatus: 'DELIVERED' }),
      );

      const result = await this.runCommand(
        'shop',
        { page: 1, item: 1, action: 'buy' },
        { chatMessage: '/shop 1 1 buy' },
      );

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.shopOrder.shopOrderControllerClaim).to.have.been.calledOnceWith(orderId);
    },
  }),

  createModuleTest({
    name: 'The listing line shows a finite stock and says nothing for an unlimited one',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () =>
        paginated([{ ...stoneListing, stock: 4 }, woodListing]),
      );

      const result = await this.runCommand('shop', { page: 1, item: 0, action: 'none' }, { chatMessage: '/shop 1' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        '1 - Test item - 100 test coin (4 left). 1x Stone',
        '2 - Wood item - 33 test coin. 1x Wood',
      ]);
    },
  }),

  createModuleTest({
    name: 'A refused purchase reaches the player as the reason, not the generic failure',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () => paginated([stoneListing]));
      this.client.stubs.shopOrder.shopOrderControllerCreate?.callsFake(async () => {
        // Only a TakaroUserError's message reaches the player; anything else is a generic failure.
        const error: Error & { response?: unknown } = new Error('Request failed with status code 400');
        error.response = {
          status: 400,
          data: { meta: { error: { code: 'BadRequestError', message: 'This listing is sold out' } } },
        };
        throw error;
      });

      const result = await this.runCommand(
        'shop',
        { page: 1, item: 1, action: 'buy' },
        { chatMessage: '/shop 1 1 buy' },
      );

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('This listing is sold out');
      expect(this.client.stubs.shopOrder.shopOrderControllerClaim).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'A transport failure is not dressed up as a refusal',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () => paginated([stoneListing]));
      this.client.stubs.shopOrder.shopOrderControllerCreate?.callsFake(async () => {
        throw new Error('socket hang up');
      });

      const result = await this.runCommand(
        'shop',
        { page: 1, item: 1, action: 'buy' },
        { chatMessage: '/shop 1 1 buy' },
      );

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(undefined);
    },
  }),

  createModuleTest({
    name: 'A 500 does not put the server message into game chat',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () => paginated([stoneListing]));
      this.client.stubs.shopOrder.shopOrderControllerCreate?.callsFake(async () => {
        // The refusal vocabulary is always a 400; a 500's internals must never reach the player.
        const error: Error & { response?: unknown } = new Error('Request failed with status code 500');
        error.response = {
          status: 500,
          data: { meta: { error: { code: 'InternalServerError', message: 'relation shopOrder does not exist' } } },
        };
        throw error;
      });

      const result = await this.runCommand(
        'shop',
        { page: 1, item: 1, action: 'buy' },
        { chatMessage: '/shop 1 1 buy' },
      );

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(undefined);
      expect(this.pms().join(' ')).to.not.include('relation shopOrder');
    },
  }),

  createModuleTest({
    name: 'A buy whose claim fails never tells the player the purchase simply succeeded',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      const orderId = 'd4c3b2a1-6f5e-4b7a-9c8d-1e0f2a3b4c5d';
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () => paginated([stoneListing]));
      this.client.stubs.shopOrder.shopOrderControllerCreate?.callsFake(async () =>
        single({ id: orderId, status: 'PAID' }),
      );
      this.client.stubs.shopOrder.shopOrderControllerClaim?.callsFake(async () => {
        const error: Error & { response?: unknown } = new Error('Request failed with status code 400');
        error.response = {
          status: 400,
          data: { meta: { error: { code: 'BadRequestError', message: 'You must be online in the game server' } } },
        };
        throw error;
      });

      const result = await this.runCommand(
        'shop',
        { page: 1, item: 1, action: 'buy' },
        { chatMessage: '/shop 1 1 buy' },
      );

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      // PMed only after the claim, and points at `/claim` not a retry: retrying would create a new order.
      expect(this.pms()).to.deep.equal([PENDING_PM]);
    },
  }),

  createModuleTest({
    name: 'A claim whose delivery FAILED points the player at /claim',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      const orderId = 'f1e2d3c4-5b6a-4978-8a9b-0c1d2e3f4a5b';
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () => paginated([stoneListing]));
      this.client.stubs.shopOrder.shopOrderControllerCreate?.callsFake(async () =>
        single({ id: orderId, status: 'PAID' }),
      );
      // The claim RESOLVES: the order is COMPLETED, and its delivery definitively failed.
      this.client.stubs.shopOrder.shopOrderControllerClaim?.callsFake(async () =>
        single({ id: orderId, status: 'COMPLETED', deliveryStatus: 'FAILED' }),
      );

      const result = await this.runCommand(
        'shop',
        { page: 1, item: 1, action: 'buy' },
        { chatMessage: '/shop 1 1 buy' },
      );

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([PENDING_PM]);
    },
  }),

  createModuleTest({
    name: 'A claim whose delivery is UNKNOWN sends the player to an admin, never to buy again',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      const orderId = 'a9e2d3c4-5b6a-4978-8a9b-0c1d2e3f4a5b';
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () => paginated([stoneListing]));
      this.client.stubs.shopOrder.shopOrderControllerCreate?.callsFake(async () =>
        single({ id: orderId, status: 'PAID' }),
      );
      this.client.stubs.shopOrder.shopOrderControllerClaim?.callsFake(async () =>
        single({ id: orderId, status: 'COMPLETED', deliveryStatus: 'UNKNOWN' }),
      );

      const result = await this.runCommand(
        'shop',
        { page: 1, item: 1, action: 'buy' },
        { chatMessage: '/shop 1 1 buy' },
      );

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Your purchase of Test item went through, but Takaro could not confirm the items were handed over. Ask an admin to check it, and do not buy it again.',
      ]);
    },
  }),

  createModuleTest({
    name: 'An instant buy whose delivery FAILED never prints the purchase confirmation',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () => paginated([stoneListing]));
      this.client.stubs.shopOrder.shopOrderControllerCreate?.callsFake(async () =>
        single({ id: 'b3e2d3c4-5b6a-4978-8a9b-0c1d2e3f4a5b', status: 'COMPLETED', deliveryStatus: 'FAILED' }),
      );

      const result = await this.runCommand(
        'shop',
        { page: 1, item: 1, action: 'buy' },
        { chatMessage: '/shop 1 1 buy' },
      );

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([PENDING_PM]);
      expect(this.pms().some((pm) => pm.startsWith('You have purchased'))).to.equal(false);
      expect(this.client.stubs.shopOrder.shopOrderControllerClaim).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'The detail view prints a listing variable requirement',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      // The module only PRINTS the requirement; the server enforces it (case below).
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () =>
        paginated([
          {
            ...stoneListing,
            requiredVariableKey: 'daily_streak',
            requiredVariableOperator: 'gte',
            requiredVariableThreshold: 20,
          },
        ]),
      );

      const result = await this.runCommand('shop', { page: 1, item: 1, action: 'none' }, { chatMessage: '/shop 1 1' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.include('Requires daily_streak at least 20.');
    },
  }),

  createModuleTest({
    name: 'The detail view prints no requirement line for a listing without one',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () => paginated([woodListing]));

      const result = await this.runCommand('shop', { page: 1, item: 1, action: 'none' }, { chatMessage: '/shop 1 1' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms().some((pm) => pm.startsWith('Requires '))).to.be.false;
    },
  }),

  createModuleTest({
    name: 'A purchase refused on a variable requirement reaches the player as the reason',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      this.client.stubs.shopListing.shopListingControllerSearch?.callsFake(async () => paginated([stoneListing]));
      this.client.stubs.shopOrder.shopOrderControllerCreate?.callsFake(async () => {
        const error: Error & { response?: unknown } = new Error('Request failed with status code 400');
        error.response = {
          status: 400,
          data: {
            meta: {
              error: {
                code: 'BadRequestError',
                message: 'You do not meet the requirement to buy this listing',
              },
            },
          },
        };
        throw error;
      });

      const result = await this.runCommand(
        'shop',
        { page: 1, item: 1, action: 'buy' },
        { chatMessage: '/shop 1 1 buy' },
      );

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You do not meet the requirement to buy this listing');
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
