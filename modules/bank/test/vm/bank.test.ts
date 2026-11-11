import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, type ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const KEY = 'bank_account';
const ECONOMY_ON = { economyEnabled: 'true' };
const OTHER_MODULE_ID = 'b7c3e9a1-4f28-4d6b-9a05-2e8c7d1f3b60';

function seed(ctx: ModuleTest, playerId: string, account: Record<string, unknown>, moduleId = ctx.moduleId) {
  ctx.variables.insert({ key: KEY, value: JSON.stringify(account), gameServerId: ctx.gameServerId, moduleId, playerId });
}

function accountOf(ctx: ModuleTest, playerId: string) {
  const rows = ctx.variables.all.filter(
    (r) => r.key === KEY && r.playerId === playerId && r.moduleId === ctx.moduleId && r.gameServerId === ctx.gameServerId,
  );
  expect(rows.length).to.be.at.most(1);
  return rows[0] ? JSON.parse(rows[0].value) : null;
}

const tests = [
  createModuleTest({
    name: 'bank with no account shows zero and the minimum balance hint',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 500,
    test: async function () {
      const result = await this.runCommand('bank');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const pms = this.pms();
      expect(pms[0]).to.equal('Bank: 0 test coin | Wallet: 500 test coin');
      expect(pms[1]).to.equal('Interest: 1%. Keep at least 100 test coin in the bank to earn it.');
      expect(pms[pms.length - 1]).to.equal('Use /bank deposit <amount|all> or /bank withdraw <amount|all>.');
      expect(this.variables.all).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'bank shows the next interest with the VIP rate and time to payout',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 0,
    permissions: [{ permission: 'BANK_VIP_RATE', count: 3 }],
    setup: function () {
      seed(this, this.pog.playerId, { balance: 2000, totalInterest: 40, lastInterest: 20 });
    },
    test: async function () {
      const result = await this.runCommand('bank');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const pms = this.pms();
      expect(pms[0]).to.equal('Bank: 2,000 test coin | Wallet: 0 test coin');
      expect(pms[1]).to.match(/^Next interest: \+60 test coin in .+ \(3% VIP rate\)\.$/);
      expect(pms[2]).to.equal('Last interest: +20 test coin. Total earned: 40.');
    },
  }),

  createModuleTest({
    name: 'deposit moves currency from wallet to bank',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 500,
    player: { name: 'Saver' },
    test: async function () {
      const result = await this.runCommand('bank', { action: 'deposit', amount: '200' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Deposited 200 test coin. Bank: 200 | Wallet: 300.']);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(300);
      const acc = accountOf(this, this.pog.playerId);
      expect(acc.balance).to.equal(200);
      expect(acc.name).to.equal('Saver');
    },
  }),

  createModuleTest({
    name: 'deposit all is capped at the max bank balance',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 500,
    userConfig: { maxBankBalance: 150 },
    setup: function () {
      seed(this, this.pog.playerId, { balance: 100 });
      // Same player, other module: must not be read or written.
      seed(this, this.pog.playerId, { balance: 9999 }, OTHER_MODULE_ID);
    },
    test: async function () {
      const result = await this.runCommand('bank', { action: 'deposit', amount: 'all' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(450);
      expect(accountOf(this, this.pog.playerId).balance).to.equal(150);
      expect(this.variables.all).to.have.length(2);

      const full = await this.runCommand('bank', { action: 'deposit', amount: '1' });
      expect(full.success).to.be.false;
      expect(this.userError(full)).to.equal('Your bank is full (limit 150 test coin).');
    },
  }),

  createModuleTest({
    name: 'deposit more than the wallet holds is refused and changes nothing',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 50,
    test: async function () {
      const result = await this.runCommand('bank', { action: 'deposit', amount: '100' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You only have 50 test coin in your wallet.');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(50);
      expect(this.variables.all).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'deposit with a bad amount shows usage',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 50,
    test: async function () {
      for (const amount of ['', 'abc', '0', '-5', '1.5']) {
        const result = await this.runCommand('bank', { action: 'deposit', amount });
        expect(result.success, amount).to.be.false;
        expect(this.userError(result)).to.equal(
          'Usage: /bank deposit <amount|all>. The amount must be a whole number above 0.',
        );
      }
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(50);
    },
  }),

  createModuleTest({
    name: 'withdraw takes the fee and pays the rest to the wallet',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 10,
    userConfig: { withdrawFeePercent: 10 },
    setup: function () {
      seed(this, this.pog.playerId, { balance: 1000 });
    },
    test: async function () {
      const result = await this.runCommand('bank', { action: 'withdraw', amount: '505' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      // fee = floor(505 * 10%) = 50
      expect(this.pms()).to.deep.equal(['Withdrew 455 test coin (fee 50). Bank: 495 | Wallet: 465.']);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(465);
      expect(accountOf(this, this.pog.playerId).balance).to.equal(495);
    },
  }),

  createModuleTest({
    name: 'withdraw all empties the bank; withdrawing more than held is refused',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 0,
    setup: function () {
      seed(this, this.pog.playerId, { balance: 300 });
    },
    test: async function () {
      const tooMuch = await this.runCommand('bank', { action: 'withdraw', amount: '301' });
      expect(tooMuch.success).to.be.false;
      expect(this.userError(tooMuch)).to.equal('You only have 300 test coin in the bank.');

      const all = await this.runCommand('bank', { action: 'withdraw', amount: 'all' });
      expect(all.success, JSON.stringify(all.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(300);
      expect(accountOf(this, this.pog.playerId).balance).to.equal(0);

      const empty = await this.runCommand('bank', { action: 'withdraw', amount: 'all' });
      expect(this.userError(empty)).to.equal('Your bank balance is empty.');
    },
  }),

  createModuleTest({
    name: 'unknown action shows usage',
    module: MODULE,
    settings: ECONOMY_ON,
    test: async function () {
      const result = await this.runCommand('bank', { action: 'rob' });
      expect(this.userError(result)).to.equal(
        'Usage: /bank | /bank deposit <amount|all> | /bank withdraw <amount|all>',
      );
    },
  }),

  createModuleTest({
    name: 'bank is closed when the economy is disabled',
    module: MODULE,
    settings: { economyEnabled: 'false' },
    currency: 100,
    test: async function () {
      const result = await this.runCommand('bank', { action: 'deposit', amount: '10' });
      expect(this.userError(result)).to.equal('The bank is closed: the economy is not enabled on this server.');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(100);
    },
  }),

  createModuleTest({
    name: 'payInterest pays base and VIP rates, respects minimum and cap',
    module: MODULE,
    settings: ECONOMY_ON,
    userConfig: { interestRatePercent: 1, maxInterestPerPayout: 40, minimumBalanceForInterest: 100 },
    otherPlayers: [
      { name: 'Poor', permissions: [] },
      { name: 'Vip', permissions: [{ permission: 'BANK_VIP_RATE', count: 5 }] },
      { name: 'Vip2', permissions: [{ permission: 'BANK_VIP_RATE', count: 2 }], online: false },
    ],
    permissions: [],
    setup: function () {
      seed(this, this.pog.playerId, { balance: 1000 });
      seed(this, this.otherPlayers[0].pog.playerId, { balance: 99 });
      seed(this, this.otherPlayers[1].pog.playerId, { balance: 1000 });
      seed(this, this.otherPlayers[2].pog.playerId, { balance: 1000, totalInterest: 5 });
    },
    test: async function () {
      const result = await this.runCronJob('payInterest');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;

      const me = accountOf(this, this.pog.playerId);
      expect(me.balance).to.equal(1010);
      expect(me.lastInterest).to.equal(10);
      expect(me.totalInterest).to.equal(10);
      expect(accountOf(this, this.otherPlayers[0].pog.playerId).balance).to.equal(99);
      // VIP 5% of 1000 = 50, capped at 40.
      expect(accountOf(this, this.otherPlayers[1].pog.playerId).balance).to.equal(1040);
      const vip2 = accountOf(this, this.otherPlayers[2].pog.playerId);
      expect(vip2.balance).to.equal(1020);
      expect(vip2.totalInterest).to.equal(25);

      expect(this.pms()).to.deep.equal(['Bank interest: +10 test coin. Bank balance: 1,010.']);
      expect(this.client.pmsTo(this.otherPlayers[1].pog.gameId)).to.deep.equal([
        'Bank interest: +40 test coin. Bank balance: 1,040.',
      ]);
      // Offline and below-minimum players get no message.
      expect(this.client.pmsTo(this.otherPlayers[0].pog.gameId)).to.deep.equal([]);
      expect(this.client.pmsTo(this.otherPlayers[2].pog.gameId)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'payInterest stops at the max bank balance',
    module: MODULE,
    settings: ECONOMY_ON,
    userConfig: { interestRatePercent: 10, maxInterestPerPayout: 0, maxBankBalance: 1050 },
    permissions: [],
    setup: function () {
      seed(this, this.pog.playerId, { balance: 1000 });
    },
    test: async function () {
      await this.runCronJob('payInterest');
      expect(accountOf(this, this.pog.playerId).balance).to.equal(1050);
      await this.runCronJob('payInterest');
      expect(accountOf(this, this.pog.playerId).balance).to.equal(1050);
    },
  }),

  createModuleTest({
    name: 'payInterest does nothing when the economy is disabled',
    module: MODULE,
    settings: { economyEnabled: 'false' },
    permissions: [],
    setup: function () {
      seed(this, this.pog.playerId, { balance: 1000 });
    },
    test: async function () {
      const result = await this.runCronJob('payInterest');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(accountOf(this, this.pog.playerId).balance).to.equal(1000);
    },
  }),

  createModuleTest({
    name: 'bankstats needs BANK_MANAGE',
    module: MODULE,
    settings: ECONOMY_ON,
    permissions: [],
    test: async function () {
      const result = await this.runCommand('bankstats');
      expect(this.userError(result)).to.equal('You do not have permission to see bank stats.');
    },
  }),

  createModuleTest({
    name: 'bankstats shows total held and top savers in order',
    module: MODULE,
    settings: ECONOMY_ON,
    permissions: [{ permission: 'BANK_MANAGE' }],
    userConfig: { topSaversCount: 2 },
    otherPlayers: [{ name: 'Alice' }, { name: 'Bob' }],
    setup: function () {
      seed(this, this.pog.playerId, { balance: 50, totalInterest: 0 });
      seed(this, this.otherPlayers[0].pog.playerId, { balance: 5000, name: 'Alice', totalInterest: 100 });
      // No stored name: falls back to the player record.
      seed(this, this.otherPlayers[1].pog.playerId, { balance: 1200, totalInterest: 20 });
    },
    test: async function () {
      const result = await this.runCommand('bankstats');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Bank stats: 3 accounts hold 6,250 test coin. 2 earn interest. Interest paid so far: 120.',
        'Top 2 savers:',
        '1. Alice: 5,000 test coin',
        '2. Bob: 1,200 test coin',
      ]);
    },
  }),
];

describe('bank suite (module-VM)', function () {
  tests.forEach((test) => {
    test.run();
  });
});
