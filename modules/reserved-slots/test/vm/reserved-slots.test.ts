import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';
import type { ModuleTest, PermissionFixture } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const HOOK = 'on-player-connected';
const JOINED_AT_KEY = 'reserved-slots:joinedAt';
const NOW = new Date('2026-11-05T12:00:00.000Z');

const REGULAR: PermissionFixture = [];
const VIP: PermissionFixture = [{ permission: 'RESERVED_SLOT' }];
const STAFF: PermissionFixture = [{ permission: 'RESERVED_SLOT_EXEMPT' }];
const VIEWER: PermissionFixture = [{ permission: 'RESERVED_SLOTS_VIEW' }];

const FREED = 'Server full - slot freed for a supporter. Rejoin later or become VIP: https://example.com/vip';
const FULL =
  'Server full - the last 1 slots are reserved for supporters. Try again later or become VIP: https://example.com/vip';

/** max 4, 1 reserved => 3 public slots. */
const BASE_CONFIG = { maxPlayers: 4, reservedSlots: 1, vipLink: 'https://example.com/vip' };

function kickCalls(test: ModuleTest): Array<{ playerId: string; reason: string }> {
  const stub = test.client.stubs.gameserver.gameServerControllerKickPlayer!;
  return stub.getCalls().map((call) => ({ playerId: call.args[1] as string, reason: (call.args[2] as { reason: string }).reason }));
}

function seedJoin(test: ModuleTest, playerId: string, ms: number) {
  test.variables.create({
    key: JOINED_AT_KEY,
    value: String(ms),
    gameServerId: test.gameServerId,
    moduleId: test.moduleId,
    playerId,
  });
}

function logText(result: { logs: Array<{ msg: string }> }): string {
  return result.logs.map((log) => log.msg).join('\n');
}

const tests = [
  createModuleTest({
    name: 'maxPlayers 0 (default): module is off, nobody is kicked, join is still recorded',
    module: MODULE,
    now: NOW,
    permissions: REGULAR,
    otherPlayers: [{ permissions: REGULAR }, { permissions: REGULAR }, { permissions: REGULAR }, { permissions: REGULAR }],
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(kickCalls(this)).to.deep.equal([]);
      expect(logText(result)).to.contain('module is off');
      const rows = this.variables.all.filter((row) => row.key === JOINED_AT_KEY);
      expect(rows).to.have.length(1);
      expect(rows[0].playerId).to.equal(this.player.id);
      expect(rows[0].value).to.equal(String(NOW.getTime()));
    },
  }),

  createModuleTest({
    name: 'public slots still open: regular joiner is let in',
    module: MODULE,
    now: NOW,
    userConfig: BASE_CONFIG,
    permissions: REGULAR,
    otherPlayers: [{ permissions: REGULAR }, { permissions: REGULAR }],
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(kickCalls(this)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'regular joiner in the reserved zone is turned away with the server-full message',
    module: MODULE,
    now: NOW,
    userConfig: BASE_CONFIG,
    permissions: REGULAR,
    otherPlayers: [{ permissions: REGULAR }, { permissions: REGULAR }, { permissions: REGULAR }],
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(kickCalls(this)).to.deep.equal([{ playerId: this.player.id, reason: FULL }]);
    },
  }),

  createModuleTest({
    name: 'kickNonReservedJoiners off: regular joiner in the reserved zone stays',
    module: MODULE,
    now: NOW,
    userConfig: { ...BASE_CONFIG, kickNonReservedJoiners: false },
    permissions: REGULAR,
    otherPlayers: [{ permissions: REGULAR }, { permissions: REGULAR }, { permissions: REGULAR }],
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(kickCalls(this)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'exempt staff joining in the reserved zone is let in and kicks nobody',
    module: MODULE,
    now: NOW,
    userConfig: BASE_CONFIG,
    permissions: STAFF,
    otherPlayers: [{ permissions: REGULAR }, { permissions: REGULAR }, { permissions: REGULAR }],
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(kickCalls(this)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'VIP joins in the reserved zone: newest regular player is kicked with the friendly message',
    module: MODULE,
    now: NOW,
    userConfig: BASE_CONFIG,
    permissions: VIP,
    otherPlayers: [{ permissions: REGULAR }, { permissions: REGULAR }, { permissions: REGULAR }],
    setup: function () {
      seedJoin(this, this.otherPlayers[0].player.id, NOW.getTime() - 3_000_000);
      seedJoin(this, this.otherPlayers[1].player.id, NOW.getTime() - 60_000); // newest
      seedJoin(this, this.otherPlayers[2].player.id, NOW.getTime() - 1_000_000);
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(kickCalls(this)).to.deep.equal([{ playerId: this.otherPlayers[1].player.id, reason: FREED }]);
    },
  }),

  createModuleTest({
    name: 'VIP join, newest strategy: reserved holders and exempt staff are never picked, even if newest',
    module: MODULE,
    now: NOW,
    userConfig: BASE_CONFIG,
    permissions: VIP,
    otherPlayers: [{ permissions: VIP }, { permissions: STAFF }, { permissions: REGULAR }],
    setup: function () {
      seedJoin(this, this.otherPlayers[0].player.id, NOW.getTime() - 1_000);
      seedJoin(this, this.otherPlayers[1].player.id, NOW.getTime() - 2_000);
      seedJoin(this, this.otherPlayers[2].player.id, NOW.getTime() - 9_000_000);
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(kickCalls(this)).to.deep.equal([{ playerId: this.otherPlayers[2].player.id, reason: FREED }]);
    },
  }),

  createModuleTest({
    name: 'VIP join with only reserved/exempt players online: nobody is kicked',
    module: MODULE,
    now: NOW,
    userConfig: BASE_CONFIG,
    permissions: VIP,
    otherPlayers: [{ permissions: VIP }, { permissions: STAFF }, { permissions: 'ROOT' }],
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(kickCalls(this)).to.deep.equal([]);
      expect(logText(result)).to.contain('no regular player to kick');
    },
  }),

  createModuleTest({
    name: 'VIP join, lowestPlaytime strategy: regular with the least playtime is kicked',
    module: MODULE,
    now: NOW,
    userConfig: { ...BASE_CONFIG, kickStrategy: 'lowestPlaytime' },
    permissions: VIP,
    otherPlayers: [{ permissions: REGULAR }, { permissions: REGULAR }, { permissions: REGULAR }],
    setup: function () {
      this.otherPlayers[0].pog.playtimeSeconds = 5000;
      this.otherPlayers[1].pog.playtimeSeconds = 7200;
      this.otherPlayers[2].pog.playtimeSeconds = 120;
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(kickCalls(this)).to.deep.equal([{ playerId: this.otherPlayers[2].player.id, reason: FREED }]);
    },
  }),

  createModuleTest({
    name: 'VIP join, random strategy: uses Math.random to pick a regular player',
    module: MODULE,
    now: NOW,
    random: 0.5,
    userConfig: { ...BASE_CONFIG, kickStrategy: 'random' },
    permissions: VIP,
    otherPlayers: [{ permissions: REGULAR }, { permissions: VIP }, { permissions: REGULAR }, { permissions: REGULAR }],
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      // Fetch order follows random fixture ids, so only assert a regular (never the VIP) was picked.
      const regulars = [this.otherPlayers[0], this.otherPlayers[2], this.otherPlayers[3]];
      const calls = kickCalls(this);
      expect(calls).to.have.length(1);
      expect(regulars.map((p) => p.player.id)).to.include(calls[0].playerId);
      expect(calls[0].reason).to.equal(FREED);
    },
  }),

  createModuleTest({
    name: 'custom messages: {link}, {reserved} and {max} are filled in',
    module: MODULE,
    now: NOW,
    userConfig: { ...BASE_CONFIG, serverFullMessage: 'Full ({max} max, {reserved} reserved). See {link}' },
    permissions: REGULAR,
    otherPlayers: [{ permissions: REGULAR }, { permissions: REGULAR }, { permissions: REGULAR }],
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(kickCalls(this)).to.deep.equal([
        { playerId: this.player.id, reason: 'Full (4 max, 1 reserved). See https://example.com/vip' },
      ]);
    },
  }),

  createModuleTest({
    name: 'game without kick support: kick error is caught and logged, hook does not fail',
    module: MODULE,
    now: NOW,
    userConfig: BASE_CONFIG,
    permissions: REGULAR,
    otherPlayers: [{ permissions: REGULAR }, { permissions: REGULAR }, { permissions: REGULAR }],
    setup: function () {
      this.client.stubs.gameserver.gameServerControllerKickPlayer?.rejects(new Error('kickPlayer is not supported'));
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(logText(result)).to.contain('kick failed');
      expect(logText(result)).to.contain('kickPlayer is not supported');
    },
  }),

  createModuleTest({
    name: 'repeat join updates the existing join-time row instead of adding another',
    module: MODULE,
    now: NOW,
    userConfig: BASE_CONFIG,
    permissions: REGULAR,
    setup: function () {
      seedJoin(this, this.player.id, 1);
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const rows = this.variables.all.filter((row) => row.key === JOINED_AT_KEY);
      expect(rows).to.have.length(1);
      expect(rows[0].value).to.equal(String(NOW.getTime()));
    },
  }),

  createModuleTest({
    name: 'slots command: denied without RESERVED_SLOTS_VIEW',
    module: MODULE,
    userConfig: BASE_CONFIG,
    permissions: REGULAR,
    test: async function () {
      const result = await this.runCommand('slots');
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You do not have permission to view slot usage.');
    },
  }),

  createModuleTest({
    name: 'slots command: says the module is off when maxPlayers is 0',
    module: MODULE,
    permissions: VIEWER,
    test: async function () {
      const result = await this.runCommand('slots');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Reserved slots is off: set "Max players" in the module config first.']);
    },
  }),

  createModuleTest({
    name: 'slots command: shows usage, zone and reserved holders by name',
    module: MODULE,
    userConfig: BASE_CONFIG,
    permissions: VIEWER,
    otherPlayers: [
      { name: 'Vippy', permissions: VIP },
      { name: 'Mod', permissions: STAFF },
      { name: 'Joe', permissions: REGULAR },
    ],
    test: async function () {
      const result = await this.runCommand('slots');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Slots: 4/4 online (IN RESERVED ZONE)',
        'Public: 3/3 - Reserved: 1 - Free: 0',
        'Regular: 2 - Reserved holders: 1 - Exempt staff: 1',
        'Reserved online: Vippy',
      ]);
    },
  }),
];

describe('Reserved Slots (module-VM)', function () {
  tests.forEach((test) => {
    test.run();
  });
});
