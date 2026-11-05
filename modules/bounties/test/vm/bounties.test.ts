import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, type ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const group = 'bounties suite (module-VM)';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

type Entry = { placerId: string; placerName: string; amount: number; placedAt: string };

function seedBounty(t: ModuleTest, targetPlayerId: string, targetName: string, entries: Entry[]) {
  t.variables.insert({
    key: 'bounty',
    value: JSON.stringify({ targetName, entries }),
    gameServerId: t.gameServerId,
    moduleId: t.moduleId,
    playerId: targetPlayerId,
  });
}

function bountyRows(t: ModuleTest) {
  return t.variables.all.filter((r) => r.key === 'bounty' && r.moduleId === t.moduleId);
}

function bountyOn(t: ModuleTest, playerId: string) {
  const row = bountyRows(t).find((r) => r.playerId === playerId);
  return row ? (JSON.parse(row.value) as { targetName: string; entries: Entry[] }) : null;
}

const broadcasts = (t: ModuleTest) => t.messages.filter((m) => m.recipientGameId === undefined).map((m) => m.message);

const tests = [
  createModuleTest({
    name: 'Placing a bounty takes the money, stores it and announces it',
    module: MODULE,
    now: NOW,
    currency: 1000,
    player: { name: 'Hunter' },
    otherPlayers: [{ name: 'Target' }],
    test: async function () {
      const target = this.otherPlayers[0];
      const result = await this.runCommand('bounty-place', { target: target.pog, amount: 300 });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(700);
      const bounty = bountyOn(this, target.pog.playerId);
      expect(bounty?.targetName).to.equal('Target');
      expect(bounty?.entries).to.deep.equal([
        { placerId: this.pog.playerId, placerName: 'Hunter', amount: 300, placedAt: NOW.toISOString() },
      ]);
      expect(this.pms()[0]).to.match(/You put 300 test coin on Target\. Total pot: 300 test coin\. It is refunded if nobody claims it within 7 days\./);
      expect(broadcasts(this)).to.deep.equal(['Hunter put a 300 test coin bounty on Target! Total pot: 300 test coin.']);
    },
  }),

  createModuleTest({
    name: 'A second placement by the same player adds to their stake; others stack in the pot',
    module: MODULE,
    now: NOW,
    currency: 1000,
    userConfig: { broadcastNewBounties: false },
    otherPlayers: [{ name: 'Target' }, { name: 'Other' }],
    setup: function () {
      seedBounty(this, this.otherPlayers[0].pog.playerId, 'Target', [
        { placerId: this.otherPlayers[1].pog.playerId, placerName: 'Other', amount: 500, placedAt: daysAgo(1) },
        { placerId: this.pog.playerId, placerName: 'Me', amount: 100, placedAt: daysAgo(2) },
      ]);
    },
    test: async function () {
      const result = await this.runCommand('bounty-place', { target: this.otherPlayers[0].pog, amount: 200 });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const entries = bountyOn(this, this.otherPlayers[0].pog.playerId)!.entries;
      expect(entries).to.have.length(2);
      expect(entries.find((e) => e.placerId === this.pog.playerId)?.amount).to.equal(300);
      expect(this.pms()[0]).to.match(/Total pot: 800 test coin/);
      expect(broadcasts(this)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Placement fee is charged on top and kept out of the pot',
    module: MODULE,
    now: NOW,
    currency: 1000,
    userConfig: { placementFeePercent: 10 },
    otherPlayers: [{ name: 'Target' }],
    test: async function () {
      const result = await this.runCommand('bounty-place', { target: this.otherPlayers[0].pog, amount: 200 });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(780);
      expect(bountyOn(this, this.otherPlayers[0].pog.playerId)!.entries[0].amount).to.equal(200);
      expect(this.pms()[0]).to.match(/\(plus a 20 test coin fee\)/);
    },
  }),

  createModuleTest({
    name: 'Cannot place a bounty on yourself, below the minimum, or without enough money',
    module: MODULE,
    now: NOW,
    currency: 150,
    otherPlayers: [{ name: 'Target' }],
    test: async function () {
      const self = await this.runCommand('bounty-place', { target: this.pog, amount: 100 });
      expect(this.userError(self)).to.equal('You cannot put a bounty on yourself.');

      const low = await this.runCommand('bounty-place', { target: this.otherPlayers[0].pog, amount: 50 });
      expect(this.userError(low)).to.equal('The minimum bounty is 100 test coin.');

      const poor = await this.runCommand('bounty-place', { target: this.otherPlayers[0].pog, amount: 200 });
      expect(this.userError(poor)).to.equal('You need 200 test coin, but you only have 150.');

      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(150);
      expect(bountyRows(this)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'Without the permission a player cannot place bounties',
    module: MODULE,
    now: NOW,
    currency: 1000,
    permissions: [],
    otherPlayers: [{ name: 'Target' }],
    test: async function () {
      const result = await this.runCommand('bounty-place', { target: this.otherPlayers[0].pog, amount: 100 });
      expect(this.userError(result)).to.equal('You do not have permission to place bounties.');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(1000);
    },
  }),

  createModuleTest({
    name: 'The permission count limits how many players you can have bounties on',
    module: MODULE,
    now: NOW,
    currency: 1000,
    permissions: [{ permission: 'BOUNTIES_PLACE', count: 1 }],
    otherPlayers: [{ name: 'First' }, { name: 'Second' }],
    setup: function () {
      seedBounty(this, this.otherPlayers[0].pog.playerId, 'First', [
        { placerId: this.pog.playerId, placerName: 'Me', amount: 100, placedAt: daysAgo(1) },
      ]);
    },
    test: async function () {
      const blocked = await this.runCommand('bounty-place', { target: this.otherPlayers[1].pog, amount: 100 });
      expect(this.userError(blocked)).to.equal('You can have bounties on at most 1 players at once.');

      // Adding to the bounty you already have is still allowed.
      const topUp = await this.runCommand('bounty-place', { target: this.otherPlayers[0].pog, amount: 100 });
      expect(topUp.success, JSON.stringify(topUp.logs)).to.be.true;
    },
  }),

  createModuleTest({
    name: 'bounties lists active pots, biggest first, without expired stakes',
    module: MODULE,
    now: NOW,
    otherPlayers: [{ name: 'Small' }, { name: 'Big' }, { name: 'Old' }],
    setup: function () {
      const [small, big, old] = this.otherPlayers;
      seedBounty(this, small.pog.playerId, 'Small', [
        { placerId: big.pog.playerId, placerName: 'Big', amount: 100, placedAt: daysAgo(1) },
      ]);
      seedBounty(this, big.pog.playerId, 'Big', [
        { placerId: small.pog.playerId, placerName: 'Small', amount: 400, placedAt: daysAgo(1) },
        { placerId: old.pog.playerId, placerName: 'Old', amount: 200, placedAt: daysAgo(2) },
      ]);
      seedBounty(this, old.pog.playerId, 'Old', [
        { placerId: small.pog.playerId, placerName: 'Small', amount: 999, placedAt: daysAgo(8) },
      ]);
    },
    test: async function () {
      const result = await this.runCommand('bounty-list');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Active bounties:\n1. Big: 600 test coin (2 players)\n2. Small: 100 test coin']);
    },
  }),

  createModuleTest({
    name: 'bounties with nothing active points to the bounty command',
    module: MODULE,
    now: NOW,
    test: async function () {
      await this.runCommand('bounty-list');
      expect(this.pms()).to.deep.equal(['There are no active bounties. Place one with /bounty <player> <amount>.']);
    },
  }),

  createModuleTest({
    name: 'bountycancel refunds your stake minus the cancel fee and leaves other stakes',
    module: MODULE,
    now: NOW,
    currency: 0,
    otherPlayers: [{ name: 'Target' }, { name: 'Other' }],
    setup: function () {
      seedBounty(this, this.otherPlayers[0].pog.playerId, 'Target', [
        { placerId: this.pog.playerId, placerName: 'Me', amount: 500, placedAt: daysAgo(1) },
        { placerId: this.otherPlayers[1].pog.playerId, placerName: 'Other', amount: 300, placedAt: daysAgo(1) },
      ]);
    },
    test: async function () {
      const result = await this.runCommand('bounty-cancel', { target: this.otherPlayers[0].pog });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(450);
      expect(this.pms()).to.deep.equal(['Your bounty on Target is cancelled. 450 test coin refunded (50 test coin cancel fee kept).']);
      expect(bountyOn(this, this.otherPlayers[0].pog.playerId)!.entries.map((e) => e.placerName)).to.deep.equal(['Other']);

      const again = await this.runCommand('bounty-cancel', { target: this.otherPlayers[0].pog });
      expect(this.userError(again)).to.equal('You have no active bounty on Target.');
    },
  }),

  createModuleTest({
    name: 'Killing the target pays the whole pot to the killer and announces it',
    module: MODULE,
    now: NOW,
    player: { name: 'Victim' },
    otherPlayers: [{ name: 'Killer' }, { name: 'PlacerA' }, { name: 'PlacerB' }],
    setup: function () {
      const [, a, b] = this.otherPlayers;
      seedBounty(this, this.pog.playerId, 'Victim', [
        { placerId: a.pog.playerId, placerName: 'PlacerA', amount: 300, placedAt: daysAgo(1) },
        { placerId: b.pog.playerId, placerName: 'PlacerB', amount: 200, placedAt: daysAgo(3) },
      ]);
    },
    test: async function () {
      const killer = this.otherPlayers[0];
      const result = await this.runHook('on-player-death', {
        eventType: 'player-death',
        eventData: { player: { gameId: this.pog.gameId, name: 'Victim' }, attacker: { gameId: killer.pog.gameId, name: 'Killer' } },
      });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(killer.pog.playerId)).to.equal(500);
      expect(bountyRows(this)).to.have.length(0);
      expect(broadcasts(this)).to.deep.equal(['Killer collected the 500 test coin bounty on Victim!']);
    },
  }),

  createModuleTest({
    name: 'A death without an attacker (PvE, or a game that does not report one) claims nothing',
    module: MODULE,
    now: NOW,
    otherPlayers: [{ name: 'Placer' }],
    setup: function () {
      seedBounty(this, this.pog.playerId, 'Victim', [
        { placerId: this.otherPlayers[0].pog.playerId, placerName: 'Placer', amount: 300, placedAt: daysAgo(1) },
      ]);
    },
    test: async function () {
      const result = await this.runHook('on-player-death', {
        eventType: 'player-death',
        eventData: { player: { gameId: this.pog.gameId, name: 'Victim' } },
      });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(bountyOn(this, this.pog.playerId)!.entries).to.have.length(1);
      expect(this.messages).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'A killer cannot claim their own stake; it stays on the board for others',
    module: MODULE,
    now: NOW,
    player: { name: 'Victim' },
    otherPlayers: [{ name: 'Killer' }, { name: 'Other' }],
    setup: function () {
      const [killer, other] = this.otherPlayers;
      seedBounty(this, this.pog.playerId, 'Victim', [
        { placerId: killer.pog.playerId, placerName: 'Killer', amount: 400, placedAt: daysAgo(1) },
        { placerId: other.pog.playerId, placerName: 'Other', amount: 100, placedAt: daysAgo(1) },
      ]);
    },
    test: async function () {
      const killer = this.otherPlayers[0];
      const result = await this.runHook('on-player-death', {
        eventType: 'player-death',
        eventData: { player: { gameId: this.pog.gameId }, attacker: { gameId: killer.pog.gameId, name: 'Killer' } },
      });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(killer.pog.playerId)).to.equal(100);
      expect(bountyOn(this, this.pog.playerId)!.entries.map((e) => e.placerName)).to.deep.equal(['Killer']);
    },
  }),

  createModuleTest({
    name: 'Only your own stake on the target: you get a PM and nothing is paid',
    module: MODULE,
    now: NOW,
    player: { name: 'Victim' },
    otherPlayers: [{ name: 'Killer' }],
    setup: function () {
      seedBounty(this, this.pog.playerId, 'Victim', [
        { placerId: this.otherPlayers[0].pog.playerId, placerName: 'Killer', amount: 400, placedAt: daysAgo(1) },
      ]);
    },
    test: async function () {
      const killer = this.otherPlayers[0];
      await this.runHook('on-player-death', {
        eventType: 'player-death',
        eventData: { player: { gameId: this.pog.gameId }, attacker: { gameId: killer.pog.gameId, name: 'Killer' } },
      });
      expect(this.currency.balanceOf(killer.pog.playerId)).to.equal(0);
      expect(this.client.pmsTo(killer.pog.gameId)).to.deep.equal([
        'You cannot claim your own bounty on Victim. It stays active for others.',
      ]);
    },
  }),

  createModuleTest({
    name: 'Players in the same exclusion group cannot claim on each other',
    module: MODULE,
    now: NOW,
    player: { name: 'Victim' },
    userConfig: { exclusionGroups: ['victim, killer'] },
    otherPlayers: [{ name: 'Killer' }, { name: 'Placer' }],
    setup: function () {
      seedBounty(this, this.pog.playerId, 'Victim', [
        { placerId: this.otherPlayers[1].pog.playerId, placerName: 'Placer', amount: 300, placedAt: daysAgo(1) },
      ]);
    },
    test: async function () {
      const killer = this.otherPlayers[0];
      const result = await this.runHook('on-player-death', {
        eventType: 'player-death',
        eventData: { player: { gameId: this.pog.gameId }, attacker: { gameId: killer.pog.gameId, name: 'Killer' } },
      });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(killer.pog.playerId)).to.equal(0);
      expect(bountyOn(this, this.pog.playerId)!.entries).to.have.length(1);
      expect(this.client.pmsTo(killer.pog.gameId)).to.deep.equal([
        'You and Victim are in the same group, so you cannot claim their bounty.',
      ]);
    },
  }),

  createModuleTest({
    name: 'An expired stake is refunded to its placer at claim time instead of paid out',
    module: MODULE,
    now: NOW,
    otherPlayers: [{ name: 'Killer' }, { name: 'OldPlacer' }, { name: 'NewPlacer' }],
    setup: function () {
      const [, old, fresh] = this.otherPlayers;
      seedBounty(this, this.pog.playerId, 'Victim', [
        { placerId: old.pog.playerId, placerName: 'OldPlacer', amount: 300, placedAt: daysAgo(10) },
        { placerId: fresh.pog.playerId, placerName: 'NewPlacer', amount: 200, placedAt: daysAgo(1) },
      ]);
    },
    test: async function () {
      const [killer, old] = this.otherPlayers;
      await this.runHook('on-player-death', {
        eventType: 'player-death',
        eventData: { player: { gameId: this.pog.gameId }, attacker: { gameId: killer.pog.gameId, name: 'Killer' } },
      });
      expect(this.currency.balanceOf(killer.pog.playerId)).to.equal(200);
      expect(this.currency.balanceOf(old.pog.playerId)).to.equal(300);
      expect(bountyRows(this)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'A 7 Days to Die "killed by" log line pays the bounty',
    module: MODULE,
    now: NOW,
    player: { name: 'Victim' },
    otherPlayers: [{ name: 'Killer' }, { name: 'Placer' }],
    setup: function () {
      seedBounty(this, this.pog.playerId, 'Victim', [
        { placerId: this.otherPlayers[1].pog.playerId, placerName: 'Placer', amount: 250, placedAt: daysAgo(1) },
      ]);
    },
    test: async function () {
      const killer = this.otherPlayers[0];
      const result = await this.runHook('on-kill-log', {
        eventType: 'log',
        withPlayer: false,
        eventData: { msg: "GMSG: Player 'Victim' killed by 'Killer'" },
      });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(killer.pog.playerId)).to.equal(250);
      expect(bountyRows(this)).to.have.length(0);
      expect(broadcasts(this)).to.deep.equal(['Killer collected the 250 test coin bounty on Victim!']);
    },
  }),

  createModuleTest({
    name: 'A "killed by" log line with a non-player killer claims nothing',
    module: MODULE,
    now: NOW,
    player: { name: 'Victim' },
    otherPlayers: [{ name: 'Placer' }],
    setup: function () {
      seedBounty(this, this.pog.playerId, 'Victim', [
        { placerId: this.otherPlayers[0].pog.playerId, placerName: 'Placer', amount: 250, placedAt: daysAgo(1) },
      ]);
    },
    test: async function () {
      const result = await this.runHook('on-kill-log', {
        eventType: 'log',
        withPlayer: false,
        eventData: { msg: "GMSG: Player 'Victim' killed by 'zombieBoe'" },
      });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(bountyOn(this, this.pog.playerId)!.entries).to.have.length(1);
      expect(this.messages).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'The expiry cron refunds old stakes in full and keeps fresh ones',
    module: MODULE,
    now: NOW,
    otherPlayers: [{ name: 'Target' }, { name: 'Old' }, { name: 'Fresh' }],
    setup: function () {
      const [target, old, fresh] = this.otherPlayers;
      seedBounty(this, target.pog.playerId, 'Target', [
        { placerId: old.pog.playerId, placerName: 'Old', amount: 300, placedAt: daysAgo(7) },
        { placerId: fresh.pog.playerId, placerName: 'Fresh', amount: 100, placedAt: daysAgo(6) },
      ]);
    },
    test: async function () {
      const [target, old] = this.otherPlayers;
      const result = await this.runCronJob('expire-bounties');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(old.pog.playerId)).to.equal(300);
      expect(bountyOn(this, target.pog.playerId)!.entries.map((e) => e.placerName)).to.deep.equal(['Fresh']);
      expect(this.client.pmsTo(old.pog.gameId)).to.deep.equal(['Nobody claimed your bounty on Target. 300 test coin refunded.']);
    },
  }),

  createModuleTest({
    name: 'With expiryDays 0 nothing ever expires',
    module: MODULE,
    now: NOW,
    userConfig: { expiryDays: 0 },
    otherPlayers: [{ name: 'Target' }, { name: 'Old' }],
    setup: function () {
      seedBounty(this, this.otherPlayers[0].pog.playerId, 'Target', [
        { placerId: this.otherPlayers[1].pog.playerId, placerName: 'Old', amount: 300, placedAt: daysAgo(400) },
      ]);
    },
    test: async function () {
      await this.runCronJob('expire-bounties');
      expect(bountyOn(this, this.otherPlayers[0].pog.playerId)!.entries).to.have.length(1);
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
