import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';
import type { ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

// Dec 5 2026, 10:00 UTC -> door 5 of the default calendar, next door in 14h.
const DEC5 = new Date('2026-12-05T10:00:00.000Z');
const DEC24 = new Date('2026-12-24T08:00:00.000Z');
const NOV26 = new Date('2026-11-26T12:00:00.000Z');
const DEC26 = new Date('2026-12-26T12:00:00.000Z');

function progress(t: ModuleTest, key = 'advent_progress_2026-12-01') {
  const row = t.variables.all.find((v) => v.key === key && v.playerId === t.pog.playerId);
  return row ? JSON.parse(row.value) : null;
}

function seedProgress(t: ModuleTest, value: Record<string, unknown>, key = 'advent_progress_2026-12-01') {
  t.variables.insert({
    key,
    value: JSON.stringify(value),
    gameServerId: t.gameServerId,
    moduleId: t.moduleId,
    playerId: t.pog.playerId,
  });
}

const broadcasts = (t: ModuleTest) => t.messages.filter((m) => m.recipientGameId === undefined).map((m) => m.message);

const tests = [
  createModuleTest({
    name: 'opens today\'s door and pays the daily currency',
    module: MODULE,
    now: DEC5,
    permissions: [],
    test: async function () {
      const result = await this.runCommand('advent');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(50);
      expect(this.pms()).to.deep.equal([
        'You opened door 5 of the Advent calendar: 50 test coin.',
        'Doors opened: 1/24. Next door in 14h.',
        'Missed doors: 1, 2, 3, 4 (locked). Come back every day!',
      ]);
      expect(progress(this)).to.deep.equal({ opened: [5], catchUps: 0 });
      // Default broadcast mode is lastDay: nothing for door 5.
      expect(broadcasts(this)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'second open on the same day is refused and pays nothing',
    module: MODULE,
    now: DEC5,
    permissions: [],
    test: async function () {
      await this.runCommand('advent');
      const result = await this.runCommand('advent');
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You already opened door 5 today. Next door in 14h. Doors opened: 1/24.');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(50);
    },
  }),

  createModuleTest({
    name: 'door claim blocks a double payout even when progress was not saved',
    module: MODULE,
    now: DEC5,
    permissions: [],
    setup: function () {
      this.variables.insert({
        key: 'advent_door_2026-12-01_5',
        value: '1',
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
        playerId: this.pog.playerId,
      });
    },
    test: async function () {
      const result = await this.runCommand('advent');
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You already opened door 5.');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);
    },
  }),

  createModuleTest({
    name: 'missed door is locked without the catch-up permission',
    module: MODULE,
    now: DEC5,
    permissions: [],
    test: async function () {
      const result = await this.runCommand('advent', { day: 2 });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(
        'Door 2 is locked: you missed that day. Only today\'s door (5) can be opened.',
      );
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);
    },
  }),

  createModuleTest({
    name: 'VIP catch-up opens a missed door and respects the count',
    module: MODULE,
    now: DEC5,
    permissions: [{ permission: 'ADVENT_CALENDAR_CATCH_UP', count: 1 }],
    test: async function () {
      const first = await this.runCommand('advent', { day: 2 });
      expect(first.success, JSON.stringify(first.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Catch-up! You opened door 2 of the Advent calendar: 50 test coin.',
        'Doors opened: 1/24.',
      ]);
      const second = await this.runCommand('advent', { day: 3 });
      expect(second.success).to.be.false;
      expect(this.userError(second)).to.equal('You used all 1 of your catch-ups for missed doors.');
      expect(progress(this)).to.deep.equal({ opened: [2], catchUps: 1 });
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(50);
    },
  }),

  createModuleTest({
    name: 'VIP sees the catch-up hint after opening today',
    module: MODULE,
    now: DEC5,
    permissions: [{ permission: 'ADVENT_CALENDAR_CATCH_UP' }],
    setup: function () {
      seedProgress(this, { opened: [1, 2], catchUps: 0 });
    },
    test: async function () {
      const result = await this.runCommand('advent');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'You opened door 5 of the Advent calendar: 50 test coin.',
        'Doors opened: 3/24. Next door in 14h.',
        'Missed doors: 3, 4. You can still open them: /advent <door>.',
      ]);
    },
  }),

  createModuleTest({
    name: 'future door is refused',
    module: MODULE,
    now: DEC5,
    test: async function () {
      const result = await this.runCommand('advent', { day: 7 });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('Door 7 opens on Dec 7, in 1d 14h. Today is door 5.');
      const tooFar = await this.runCommand('advent', { day: 30 });
      expect(this.userError(tooFar)).to.equal('Pick a door from 1 to 24. Today is door 5.');
    },
  }),

  createModuleTest({
    name: 'before the start it tells when the calendar opens',
    module: MODULE,
    now: NOV26,
    test: async function () {
      const result = await this.runCommand('advent');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['The Advent calendar opens in 4d 12h (Dec 1). 24 doors to open, one per day!']);
    },
  }),

  createModuleTest({
    name: 'after the end it shows the final count',
    module: MODULE,
    now: DEC26,
    setup: function () {
      seedProgress(this, { opened: [1, 2, 24], catchUps: 0 });
    },
    test: async function () {
      const result = await this.runCommand('advent');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['The Advent calendar is over. You opened 3 of 24 doors.']);
    },
  }),

  createModuleTest({
    name: 'last door pays the big gift, items and role, and broadcasts',
    module: MODULE,
    now: DEC24,
    permissions: [],
    userConfig: { lastDayItems: [{ item: 'item-gift', amount: 2 }], lastDayRoleId: 'role-elf', roleDays: 30 },
    setup: function () {
      seedProgress(this, { opened: Array.from({ length: 23 }, (_, i) => i + 1), catchUps: 0 });
    },
    test: async function () {
      const result = await this.runCommand('advent');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(500);
      expect(this.client.stubs.gameserver.gameServerControllerGiveItem).to.have.been.calledOnceWith(
        this.gameServerId,
        this.pog.playerId,
        { name: 'item-gift', amount: 2, quality: '' },
      );
      const assign = this.client.stubs.player.playerControllerAssignRole!;
      expect(assign).to.have.been.calledOnce;
      expect(assign.firstCall.args[0]).to.equal(this.pog.playerId);
      expect(assign.firstCall.args[1]).to.equal('role-elf');
      expect(assign.firstCall.args[2]).to.deep.equal({
        gameServerId: this.gameServerId,
        expiresAt: new Date(DEC24.getTime() + 30 * 86400000).toISOString(),
      });
      const pms = this.pms();
      expect(pms[0]).to.match(/^You opened door 24 of the Advent calendar: 500 test coin, 2x .+, role .+\.$/);
      expect(pms[1]).to.equal('That was the last door! You opened 24 of 24 doors.');
      expect(broadcasts(this)).to.have.length(1);
      expect(broadcasts(this)[0]).to.match(/^Test player opened door 24 of the Advent calendar and got 500 test coin/);
    },
  }),

  createModuleTest({
    name: 'custom door replaces the default gift; broadcast all',
    module: MODULE,
    now: DEC5,
    userConfig: { doors: [{ day: 5, currency: 123 }], broadcast: 'all' },
    test: async function () {
      const result = await this.runCommand('advent');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(123);
      expect(broadcasts(this)).to.deep.equal([
        'Test player opened door 5 of the Advent calendar and got 123 test coin! Type /advent',
      ]);
    },
  }),

  createModuleTest({
    name: 'failed item is queued and delivered on next join',
    module: MODULE,
    now: DEC5,
    permissions: [],
    userConfig: { dailyItems: [{ item: 'item-candy', amount: 3 }] },
    test: async function () {
      const give = this.client.stubs.gameserver.gameServerControllerGiveItem!;
      give.rejects(new Error('player is offline'));
      const result = await this.runCommand('advent');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.include('1 item(s) could not be given now. You get them when you join next time.');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(50);

      give.resetBehavior();
      give.resolves();
      const hook = await this.runHook('on-join', { eventType: 'player-connected' });
      expect(hook.success, JSON.stringify(hook.logs)).to.be.true;
      expect(this.pms()).to.include('You got 1 advent calendar item(s) that could not be given before.');
      expect(this.variables.all.find((v) => v.key === 'advent_pending_items')).to.be.undefined;
    },
  }),

  createModuleTest({
    name: 'join reminder only when today is not opened',
    module: MODULE,
    now: DEC5,
    test: async function () {
      const hook = await this.runHook('on-join', { eventType: 'player-connected' });
      expect(hook.success, JSON.stringify(hook.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Door 5 of the Advent calendar is waiting for you. Type /advent to open it!',
      ]);
      await this.runCommand('advent');
      const before = this.pms().length;
      await this.runHook('on-join', { eventType: 'player-connected' });
      expect(this.pms().length).to.equal(before);
    },
  }),

  createModuleTest({
    name: 'announce cron broadcasts each new door once',
    module: MODULE,
    now: DEC5,
    test: async function () {
      const first = await this.runCronJob('announce');
      expect(first.success, JSON.stringify(first.logs)).to.be.true;
      await this.runCronJob('announce');
      expect(broadcasts(this)).to.deep.equal(['Door 5 of the Advent calendar is open! Type /advent to get your gift.']);
    },
  }),

  createModuleTest({
    name: 'announce cron is silent outside the event',
    module: MODULE,
    now: NOV26,
    test: async function () {
      await this.runCronJob('announce');
      expect(this.messages).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'time zone offset moves the door change to local midnight',
    module: MODULE,
    // 23:30 UTC on Dec 4 = 00:30 on Dec 5 at UTC+1.
    now: new Date('2026-12-04T23:30:00.000Z'),
    userConfig: { utcOffsetHours: 1 },
    test: async function () {
      await this.runCommand('advent');
      expect(this.pms()[0]).to.equal('You opened door 5 of the Advent calendar: 50 test coin.');
    },
  }),

  createModuleTest({
    name: 'reusable: Halloween calendar with 7 doors and a fixed year',
    module: MODULE,
    now: new Date('2026-10-31T12:00:00.000Z'),
    permissions: [],
    userConfig: { eventName: 'Halloween calendar', startDate: '2026-10-25', numberOfDays: 7, lastDayCurrency: 300 },
    test: async function () {
      const result = await this.runCommand('advent');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()[0]).to.equal('You opened door 7 of the Halloween calendar: 300 test coin.');
      expect(progress(this, 'advent_progress_2026-10-25')).to.deep.equal({ opened: [7], catchUps: 0 });
    },
  }),

  createModuleTest({
    name: 'MM-DD event crossing New Year still runs in January',
    module: MODULE,
    now: new Date('2027-01-03T12:00:00.000Z'),
    userConfig: { startDate: '12-25', numberOfDays: 14 },
    test: async function () {
      await this.runCommand('advent');
      expect(this.pms()[0]).to.equal('You opened door 10 of the Advent calendar: 50 test coin.');
      expect(progress(this, 'advent_progress_2026-12-25')).to.deep.include({ opened: [10] });
    },
  }),

  createModuleTest({
    name: 'adventpreview needs the manage permission',
    module: MODULE,
    now: DEC5,
    permissions: [],
    test: async function () {
      const result = await this.runCommand('adventpreview');
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('Only admins can preview the calendar.');
    },
  }),

  createModuleTest({
    name: 'adventpreview shows the overview and one door',
    module: MODULE,
    now: DEC5,
    permissions: [{ permission: 'ADVENT_CALENDAR_MANAGE' }],
    userConfig: { doors: [{ day: 12, currency: 200 }], utcOffsetHours: 5.5 },
    test: async function () {
      const result = await this.runCommand('adventpreview');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Advent calendar: 24 doors, Dec 1 to Dec 24 (UTC+5:30). It is running, today is door 5.',
        'Normal door: 50 test coin.',
        'Last door (24): 500 test coin.',
        'Custom doors: 12. Check one with /adventpreview <door>.',
        'Broadcast: lastDay. Missed doors stay locked, except for players with the catch-up permission.',
      ]);
      await this.runCommand('adventpreview', { day: 12 });
      expect(this.pms().at(-1)).to.equal('Door 12 (Dec 12) (custom): 200 test coin.');
      // Preview gives nothing.
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);
    },
  }),

  createModuleTest({
    name: 'invalid start date gives a clear error',
    module: MODULE,
    now: DEC5,
    userConfig: { startDate: 'december' },
    test: async function () {
      const result = await this.runCommand('adventpreview');
      expect(this.userError(result)).to.equal(
        'Start date \'december\' is not valid. Use MM-DD (every year, e.g. 12-01) or YYYY-MM-DD (one year).',
      );
      const player = await this.runCommand('advent');
      expect(this.userError(player)).to.equal('The Advent calendar is not set up correctly. Please tell an admin.');
    },
  }),
];

describe('advent-calendar', () => {
  for (const t of tests) t.run();
});
