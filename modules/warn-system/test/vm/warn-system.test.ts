import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, paginated } from '@takaro/module-test';
import type { ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const KEY = 'warn_system_warnings';
const NOW = new Date('2026-11-05T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const STAFF = [{ permission: 'WARN_ISSUE' }];
const MANAGER = [{ permission: 'WARN_MANAGE' }];

interface StoredWarning {
  id: number;
  reason: string;
  staffName: string;
  createdAt: string;
  delivered: boolean;
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

function warning(id: number, createdAt: string, delivered = true, reason = `old reason ${id}`) {
  return { id, reason, staffId: 'staff', staffName: 'Mod', createdAt, delivered };
}

function seed(test: ModuleTest, playerId: string, warnings: unknown[], nextId?: number) {
  test.variables.insert({
    key: KEY,
    value: JSON.stringify({ nextId: nextId ?? warnings.length + 1, warnings }),
    gameServerId: test.gameServerId,
    moduleId: test.moduleId,
    playerId,
  });
}

function stored(test: ModuleTest, playerId: string): { nextId: number; warnings: StoredWarning[] } {
  const rows = test.variables.all.filter(
    (r) => r.key === KEY && r.playerId === playerId && r.gameServerId === test.gameServerId && r.moduleId === test.moduleId,
  );
  expect(rows).to.have.length(1);
  return JSON.parse(rows[0].value);
}

function messagesTo(test: ModuleTest, gameId: string): string[] {
  return test.messages.filter((m) => m.recipientGameId === gameId).map((m) => m.message);
}

function target(test: ModuleTest) {
  return test.otherPlayers[0];
}

const tests = [
  createModuleTest({
    name: 'warn: refuses a player without WARN_ISSUE',
    module: MODULE,
    permissions: [],
    otherPlayers: [{ name: 'Bob' }],
    test: async function () {
      const result = await this.runCommand('warn', { player: target(this).pog, reason: 'spam' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You do not have permission to warn players.');
      expect(this.variables.all).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'warn: refuses to warn yourself',
    module: MODULE,
    permissions: STAFF,
    test: async function () {
      const result = await this.runCommand('warn', { player: this.pog, reason: 'test' });
      expect(this.userError(result)).to.equal('You cannot warn yourself.');
    },
  }),

  createModuleTest({
    name: 'warn: stores the warning, PMs the player with the full multi-word reason, tells staff the next step',
    module: MODULE,
    permissions: STAFF,
    now: NOW,
    player: { name: 'Admin' },
    otherPlayers: [{ name: 'Bob', online: true }],
    test: async function () {
      const bob = target(this);
      const result = await this.runCommand(
        'warn',
        { player: bob.pog, reason: 'griefing' },
        { chatMessage: '/warn Bob griefing my "base" again' },
      );
      expect(result.success, JSON.stringify(result.logs)).to.be.true;

      expect(messagesTo(this, bob.pog.gameId)).to.deep.equal([
        'You have been warned by Admin: griefing my base again. Active warnings: 1. Type /warnings to see them.',
      ]);
      expect(this.pms()).to.deep.equal([
        'Warned Bob (#1): griefing my base again. Active warnings: 1.',
        'Next step at 3 warnings: kick.',
      ]);

      const record = stored(this, bob.pog.playerId);
      expect(record.nextId).to.equal(2);
      expect(record.warnings).to.have.length(1);
      expect(record.warnings[0]).to.include({
        id: 1,
        reason: 'griefing my base again',
        staffName: 'Admin',
        createdAt: NOW.toISOString(),
        delivered: true,
      });
      // Off by default: no broadcast, no Discord, no kick/ban.
      expect(this.messages.filter((m) => m.recipientGameId === undefined)).to.have.length(0);
      expect(this.client.stubs.discord.discordControllerSendMessage).to.not.have.been.called;
      expect(this.client.stubs.gameserver.gameServerControllerKickPlayer).to.not.have.been.called;
      expect(this.client.stubs.player.banControllerCreate).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'warn: third active warning kicks an online player',
    module: MODULE,
    permissions: STAFF,
    now: NOW,
    otherPlayers: [{ name: 'Bob', online: true }],
    setup: function () {
      seed(this, target(this).pog.playerId, [warning(1, daysAgo(2)), warning(2, daysAgo(1))]);
    },
    test: async function () {
      const bob = target(this);
      const result = await this.runCommand('warn', { player: bob.pog, reason: 'spam' }, { chatMessage: '/warn Bob spam' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;

      const kick = this.client.stubs.gameserver.gameServerControllerKickPlayer;
      expect(kick).to.have.been.calledOnce;
      expect(kick?.firstCall.args[0]).to.equal(this.gameServerId);
      expect(kick?.firstCall.args[1]).to.equal(bob.pog.playerId);
      expect(kick?.firstCall.args[2]).to.deep.equal({ reason: 'Warning limit reached (3): spam' });
      expect(this.pms()).to.deep.equal(['Warned Bob (#3): spam. Active warnings: 3.', 'Bob reached 3 warnings and was kicked.']);
      expect(stored(this, bob.pog.playerId).warnings.map((w) => w.id)).to.deep.equal([1, 2, 3]);
    },
  }),

  createModuleTest({
    name: 'warn: fifth warning bans for 24 hours via the Takaro ban API',
    module: MODULE,
    permissions: STAFF,
    now: NOW,
    otherPlayers: [{ name: 'Bob', online: true }],
    setup: function () {
      seed(this, target(this).pog.playerId, [1, 2, 3, 4].map((id) => warning(id, daysAgo(1))));
    },
    test: async function () {
      const bob = target(this);
      const result = await this.runCommand('warn', { player: bob.pog, reason: 'xray' }, { chatMessage: '/warn Bob xray' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;

      const ban = this.client.stubs.player.banControllerCreate;
      expect(ban).to.have.been.calledOnceWith({
        gameServerId: this.gameServerId,
        playerId: bob.pog.playerId,
        reason: 'Warning limit reached (5): xray',
        until: new Date(NOW.getTime() + DAY).toISOString(),
      });
      expect(messagesTo(this, bob.pog.gameId)[1]).to.equal('You reached 5 warnings: 24h ban.');
      expect(this.pms()[1]).to.equal('Bob reached 5 warnings and was banned for 24h.');
      expect(this.client.stubs.gameserver.gameServerControllerKickPlayer).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'warn: seventh warning bans permanently (no expiry) even when the player is offline',
    module: MODULE,
    permissions: STAFF,
    now: NOW,
    otherPlayers: [{ name: 'Bob', online: false }],
    setup: function () {
      seed(this, target(this).pog.playerId, [1, 2, 3, 4, 5, 6].map((id) => warning(id, daysAgo(1))));
    },
    test: async function () {
      const bob = target(this);
      const result = await this.runCommand('warn', { player: bob.pog, reason: 'cheating' }, { chatMessage: '/warn Bob cheating' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;

      const ban = this.client.stubs.player.banControllerCreate;
      expect(ban).to.have.been.calledOnce;
      expect(ban?.firstCall.args[0]).to.deep.equal({
        gameServerId: this.gameServerId,
        playerId: bob.pog.playerId,
        reason: 'Warning limit reached (7): cheating',
      });
      expect(messagesTo(this, bob.pog.gameId)).to.deep.equal([]);
      expect(this.pms()).to.deep.equal([
        'Warned Bob (#7): cheating. Active warnings: 7.',
        'Bob is offline and will be told on next join.',
        'Bob reached 7 warnings and was banned permanently.',
      ]);
      expect(stored(this, bob.pog.playerId).warnings[6].delivered).to.equal(false);
    },
  }),

  createModuleTest({
    name: 'warn: offline player at the kick step is not kicked, staff is told',
    module: MODULE,
    permissions: STAFF,
    now: NOW,
    otherPlayers: [{ name: 'Bob', online: false }],
    setup: function () {
      seed(this, target(this).pog.playerId, [warning(1, daysAgo(1)), warning(2, daysAgo(1))]);
    },
    test: async function () {
      const result = await this.runCommand('warn', { player: target(this).pog, reason: 'spam' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerKickPlayer).to.not.have.been.called;
      expect(this.pms()).to.include('Bob reached 3 warnings but is offline, so was not kicked.');
    },
  }),

  createModuleTest({
    name: 'warn: expired warnings are dropped and do not count towards escalation',
    module: MODULE,
    permissions: STAFF,
    now: NOW,
    userConfig: { warningExpiryDays: 30 },
    otherPlayers: [{ name: 'Bob', online: true }],
    setup: function () {
      seed(this, target(this).pog.playerId, [warning(1, daysAgo(40)), warning(2, daysAgo(31)), warning(3, daysAgo(5))]);
    },
    test: async function () {
      const bob = target(this);
      const result = await this.runCommand('warn', { player: bob.pog, reason: 'spam' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerKickPlayer).to.not.have.been.called;
      const record = stored(this, bob.pog.playerId);
      expect(record.warnings.map((w) => w.id)).to.deep.equal([3, 4]);
      expect(this.pms()[0]).to.equal('Warned Bob (#4): spam. Active warnings: 2.');
    },
  }),

  createModuleTest({
    name: 'warn: custom ladder, broadcast and Discord log when configured',
    module: MODULE,
    permissions: STAFF,
    now: NOW,
    player: { name: 'Admin' },
    userConfig: {
      escalation: [{ warnings: 1, action: 'tempban', durationHours: 2 }],
      broadcastWarnings: true,
      discordChannelId: '123456789',
    },
    otherPlayers: [{ name: 'Bob', online: true }],
    test: async function () {
      const bob = target(this);
      const result = await this.runCommand('warn', { player: bob.pog, reason: 'rude' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;

      const broadcasts = this.messages.filter((m) => m.recipientGameId === undefined).map((m) => m.message);
      expect(broadcasts).to.deep.equal(['Bob was warned: rude']);
      expect(this.client.stubs.player.banControllerCreate?.firstCall.args[0]?.until).to.equal(
        new Date(NOW.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      );
      const discord = this.client.stubs.discord.discordControllerSendMessage;
      expect(discord).to.have.been.calledOnce;
      expect(discord?.firstCall.args[0]).to.equal('123456789');
      expect(discord?.firstCall.args[1]?.message).to.contain('**Bob** warned by **Admin** (#1, 1 active): rude');
      expect(discord?.firstCall.args[1]?.message).to.contain('banned for 2h');
    },
  }),

  createModuleTest({
    name: 'warnings: player sees own active warnings with expiry and next step',
    module: MODULE,
    permissions: [],
    now: NOW,
    setup: function () {
      seed(this, this.pog.playerId, [warning(1, daysAgo(40)), warning(4, '2026-11-01T10:00:00.000Z', false, 'spam')], 5);
    },
    test: async function () {
      const result = await this.runCommand('warnings');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'You have 1 active warning:',
        '#4 2026-11-01 by Mod: spam (expires in 26d)',
        'At 3 warnings: kick.',
      ]);
      // Viewing marks it delivered and saves the pruned list.
      const record = stored(this, this.pog.playerId);
      expect(record.warnings).to.have.length(1);
      expect(record.warnings[0].delivered).to.equal(true);
      expect(record.nextId).to.equal(5);
    },
  }),

  createModuleTest({
    name: 'warnings: no warnings',
    module: MODULE,
    permissions: [],
    test: async function () {
      const result = await this.runCommand('warnings');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['You have no active warnings.']);
      expect(this.variables.all).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'warnings: a normal player cannot look up someone else',
    module: MODULE,
    permissions: [],
    test: async function () {
      const result = await this.runCommand('warnings', { player: 'Bob' });
      expect(this.userError(result)).to.equal('You can only view your own warnings. Use the command without a name.');
    },
  }),

  createModuleTest({
    name: 'warnings: staff looks up another player by name',
    module: MODULE,
    permissions: STAFF,
    now: NOW,
    otherPlayers: [{ name: 'Bob' }, { name: 'Bobby' }],
    setup: function () {
      const [bob, bobby] = this.otherPlayers;
      seed(this, bob.pog.playerId, [warning(1, daysAgo(1), false, 'spam')]);
      // Takaro's partial name search; the fake does not model `search`, so it is stubbed here.
      this.client.stubs.player.playerControllerSearch?.callsFake(async () => paginated([bob.player, bobby.player]));
    },
    test: async function () {
      const result = await this.runCommand('warnings', { player: 'bob' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Bob has 1 active warning:', `#1 ${daysAgo(1).slice(0, 10)} by Mod: spam (expires in 29d)`, 'At 3 warnings: kick.']);
      // Staff viewing does not count as the player being told.
      expect(stored(this, this.otherPlayers[0].pog.playerId).warnings[0].delivered).to.equal(false);
    },
  }),

  createModuleTest({
    name: 'unwarn: needs WARN_MANAGE',
    module: MODULE,
    permissions: STAFF,
    otherPlayers: [{ name: 'Bob' }],
    test: async function () {
      const result = await this.runCommand('unwarn', { player: target(this).pog, id: 1 });
      expect(this.userError(result)).to.equal('You do not have permission to remove warnings.');
    },
  }),

  createModuleTest({
    name: 'unwarn: removes one warning by id; ids are not reused',
    module: MODULE,
    permissions: MANAGER,
    now: NOW,
    otherPlayers: [{ name: 'Bob' }],
    setup: function () {
      seed(this, target(this).pog.playerId, [warning(1, daysAgo(2)), warning(2, daysAgo(1))]);
    },
    test: async function () {
      const bob = target(this);
      const result = await this.runCommand('unwarn', { player: bob.pog, id: 1 });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Removed warning #1 from Bob. Active warnings: 1.']);
      const record = stored(this, bob.pog.playerId);
      expect(record.warnings.map((w) => w.id)).to.deep.equal([2]);
      expect(record.nextId).to.equal(3);

      const missing = await this.runCommand('unwarn', { player: bob.pog, id: 9 });
      expect(this.userError(missing)).to.equal('Bob has no active warning #9.');
    },
  }),

  createModuleTest({
    name: 'hook: tells a joining player about warnings they missed, once',
    module: MODULE,
    now: NOW,
    setup: function () {
      seed(this, this.pog.playerId, [warning(1, daysAgo(3)), warning(2, daysAgo(1), false, 'spam')]);
    },
    test: async function () {
      const result = await this.runHook('notify-on-join');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'While you were offline you received 1 warning. Active warnings: 2.',
        '#2 by Mod: spam',
        'Type /warnings to see all of them.',
      ]);
      expect(stored(this, this.pog.playerId).warnings.every((w) => w.delivered)).to.equal(true);

      const again = await this.runHook('notify-on-join');
      expect(again.success).to.be.true;
      expect(this.pms()).to.have.length(3);
    },
  }),

  createModuleTest({
    name: 'hook: silent when notifyOnJoin is off',
    module: MODULE,
    now: NOW,
    userConfig: { notifyOnJoin: false },
    setup: function () {
      seed(this, this.pog.playerId, [warning(1, daysAgo(1), false)]);
    },
    test: async function () {
      const result = await this.runHook('notify-on-join');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([]);
    },
  }),
];

describe('warn-system (module-VM)', function () {
  tests.forEach((t) => {
    t.run();
  });
});
