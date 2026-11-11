import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, single } from '@takaro/module-test';
import type { ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const STATE_KEY = 'happy_hour_state';
const MIN = 60 * 1000;

// 2026-11-06 is a Friday.
const FRI_2000 = new Date('2026-11-06T20:00:00.000Z');
const THU_1200 = new Date('2026-11-05T12:00:00.000Z');

function seedState(t: ModuleTest, state: Record<string, unknown>) {
  t.variables.insert({
    key: STATE_KEY,
    value: JSON.stringify(state),
    gameServerId: t.gameServerId,
    moduleId: t.moduleId,
  });
}

function readState(t: ModuleTest) {
  const rows = t.variables.all.filter(
    (row) => row.key === STATE_KEY && row.gameServerId === t.gameServerId && row.moduleId === t.moduleId,
  );
  expect(rows).to.have.length(1);
  return JSON.parse(rows[0].value);
}

function runningState(now: Date, minutesLeft: number, multiplier = 2, extra: Record<string, unknown> = {}) {
  return {
    active: true,
    startedAt: new Date(now.getTime() - 5 * MIN).toISOString(),
    endsAt: new Date(now.getTime() + minutesLeft * MIN).toISOString(),
    multiplier,
    source: 'admin',
    lastReminderAt: new Date(now.getTime() - 1 * MIN).toISOString(),
    lastPlaytimeAt: new Date(now.getTime() - 1 * MIN).toISOString(),
    lastTickAt: new Date(now.getTime() - 1 * MIN).toISOString(),
    ...extra,
  };
}

const broadcasts = (t: ModuleTest) => t.messages.filter((m) => m.recipientGameId === undefined).map((m) => m.message);

const tests = [
  // ---------- command ----------
  createModuleTest({
    name: 'status shows the next scheduled happy hour',
    module: MODULE,
    now: THU_1200,
    test: async function () {
      const result = await this.runCommand('happyhour');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      // Thu 12:00 UTC -> Fri 20:00 UTC (default schedule)
      expect(this.pms()).to.deep.equal(['No happy hour right now. Next one starts in 1d 8h.']);
    },
  }),

  createModuleTest({
    name: 'status says nothing is scheduled when schedules are empty',
    module: MODULE,
    now: THU_1200,
    userConfig: { schedules: [] },
    test: async function () {
      const result = await this.runCommand('happyhour');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['No happy hour right now, and none is scheduled.']);
    },
  }),

  createModuleTest({
    name: 'status while running shows multiplier, time left and bonuses',
    module: MODULE,
    now: THU_1200,
    userConfig: { doubleDropItems: [{ item: 'item-1', amount: 1 }] },
    setup: function () {
      seedState(this, runningState(THU_1200, 45, 3));
    },
    test: async function () {
      const result = await this.runCommand('happyhour', { action: 'status' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Happy hour is ON: x3 for 45m more. +2 test coin per kill. +20 test coin every 10 min online. 10% bonus drop chance on kills.',
      ]);
    },
  }),

  createModuleTest({
    name: 'start without permission is refused',
    module: MODULE,
    permissions: [],
    test: async function () {
      const result = await this.runCommand('happyhour', { action: 'start', minutes: 60 });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(
        'Only admins can start or stop happy hour. Type /happyhour to see the status.',
      );
      expect(this.variables.all).to.have.length(0);
      expect(this.messages).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'admin start saves state and broadcasts',
    module: MODULE,
    now: THU_1200,
    permissions: [{ permission: 'HAPPY_HOUR_MANAGE' }],
    test: async function () {
      const result = await this.runCommand('happyhour', { action: 'start', minutes: 90, multiplier: 3 });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const state = readState(this);
      expect(state.active).to.be.true;
      expect(state.multiplier).to.equal(3);
      expect(state.endsAt).to.equal(new Date(THU_1200.getTime() + 90 * MIN).toISOString());
      expect(state.source).to.equal('admin');
      expect(broadcasts(this)).to.deep.equal([
        'HAPPY HOUR! x3 rewards for the next 1h 30m. Kill, play and earn bonus test coin! Type /happyhour for details.',
      ]);
      expect(this.pms()).to.deep.equal(['Happy hour started: x3 for 90 min.']);
      // Discord is off by default.
      expect(this.client.stubs.discord.discordControllerSendMessage).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'admin start uses the config multiplier and posts to Discord when enabled',
    module: MODULE,
    now: THU_1200,
    userConfig: { multiplier: 1.5, discordAnnounce: true, discordChannelId: '123456' },
    test: async function () {
      const result = await this.runCommand('happyhour', { action: 'start', minutes: 30 });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(readState(this).multiplier).to.equal(1.5);
      expect(this.client.stubs.discord.discordControllerSendMessage).to.have.been.calledOnceWith('123456', {
        message: 'HAPPY HOUR! x1.5 rewards for the next 30m. Kill, play and earn bonus test coin! Type /happyhour for details.',
      });
    },
  }),

  createModuleTest({
    name: 'start while running updates the event instead of starting twice',
    module: MODULE,
    now: THU_1200,
    setup: function () {
      seedState(this, runningState(THU_1200, 10, 2));
    },
    test: async function () {
      const result = await this.runCommand('happyhour', { action: 'start', minutes: 60, multiplier: 4 });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const state = readState(this);
      expect(state.multiplier).to.equal(4);
      expect(state.endsAt).to.equal(new Date(THU_1200.getTime() + 60 * MIN).toISOString());
      expect(broadcasts(this)).to.deep.equal(['Happy hour changed: x4 rewards for the next 1h!']);
    },
  }),

  createModuleTest({
    name: 'start rejects bad minutes and multipliers',
    module: MODULE,
    test: async function () {
      const noMinutes = await this.runCommand('happyhour', { action: 'start' });
      expect(this.userError(noMinutes)).to.equal('Usage: /happyhour start <minutes 1-1440> [multiplier]');
      const tooLong = await this.runCommand('happyhour', { action: 'start', minutes: 5000 });
      expect(this.userError(tooLong)).to.equal('Usage: /happyhour start <minutes 1-1440> [multiplier]');
      const badMult = await this.runCommand('happyhour', { action: 'start', minutes: 10, multiplier: 50 });
      expect(this.userError(badMult)).to.equal('Multiplier must be more than 1 and at most 10 (e.g. 2 for double).');
      const unknown = await this.runCommand('happyhour', { action: 'go' });
      expect(this.userError(unknown)).to.contain("Unknown option 'go'");
      expect(this.variables.all).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'stop ends a running event and broadcasts the end',
    module: MODULE,
    now: THU_1200,
    setup: function () {
      seedState(this, runningState(THU_1200, 30));
    },
    test: async function () {
      const result = await this.runCommand('happyhour', { action: 'stop' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(readState(this).active).to.be.false;
      expect(broadcasts(this)).to.deep.equal(['Happy hour is over. Thanks for playing!']);
      expect(this.pms()).to.deep.equal(['Happy hour stopped.']);
    },
  }),

  createModuleTest({
    name: 'stop with nothing running says so',
    module: MODULE,
    test: async function () {
      const result = await this.runCommand('happyhour', { action: 'stop' });
      expect(this.userError(result)).to.equal('No happy hour is running.');
    },
  }),

  // ---------- kill hook ----------
  createModuleTest({
    name: 'kill outside happy hour pays nothing',
    module: MODULE,
    currency: 0,
    test: async function () {
      const result = await this.runHook('on-kill', { eventData: { entity: 'zombieBoe', player: { gameId: this.pog.gameId } } });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);
    },
  }),

  createModuleTest({
    name: 'kill during happy hour pays base x (multiplier - 1)',
    module: MODULE,
    now: THU_1200,
    currency: 0,
    userConfig: { killBaseReward: 5, notifyKillBonus: true },
    setup: function () {
      seedState(this, runningState(THU_1200, 30, 3));
    },
    test: async function () {
      const result = await this.runHook('on-kill', { eventData: { entity: 'zombieBoe', player: { gameId: this.pog.gameId } } });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(10);
      expect(this.pms()).to.deep.equal(['+10 test coin happy hour kill bonus']);
    },
  }),

  createModuleTest({
    name: 'VIP count raises the kill bonus by that percent',
    module: MODULE,
    now: THU_1200,
    currency: 0,
    permissions: [{ permission: 'HAPPY_HOUR_VIP_BONUS', count: 50 }],
    userConfig: { killBaseReward: 10 },
    setup: function () {
      seedState(this, runningState(THU_1200, 30, 2));
    },
    test: async function () {
      const result = await this.runHook('on-kill', { eventData: { entity: 'zombieBoe', player: { gameId: this.pog.gameId } } });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(15);
      // notifyKillBonus is off by default.
      expect(this.pms()).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'expired event (not yet closed by the tick) pays nothing',
    module: MODULE,
    now: THU_1200,
    currency: 0,
    setup: function () {
      seedState(this, runningState(THU_1200, -1, 2));
    },
    test: async function () {
      await this.runHook('on-kill', { eventData: { entity: 'zombieBoe', player: { gameId: this.pog.gameId } } });
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);
    },
  }),

  createModuleTest({
    name: 'bonus drop gives an item when the chance hits',
    module: MODULE,
    now: THU_1200,
    random: [0.05, 0],
    userConfig: { killBaseReward: 0, doubleDropChance: 10, doubleDropItems: [{ item: 'item-1', amount: 2, quality: '3' }] },
    setup: function () {
      seedState(this, runningState(THU_1200, 30));
      this.client.stubs.item.itemControllerFindOne?.callsFake(async () => single({ id: 'item-1', name: 'Canned Chili' } as never));
    },
    test: async function () {
      const result = await this.runHook('on-kill', { eventData: { entity: 'zombieBoe', player: { gameId: this.pog.gameId } } });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerGiveItem).to.have.been.calledOnceWith(
        this.gameServerId,
        this.player.id,
        { name: 'item-1', amount: 2, quality: '3' },
      );
      expect(this.pms()).to.deep.equal(['Happy hour bonus drop: 2x Canned Chili!']);
    },
  }),

  createModuleTest({
    name: 'bonus drop does nothing when the chance misses',
    module: MODULE,
    now: THU_1200,
    random: 0.5,
    userConfig: { doubleDropChance: 10, doubleDropItems: [{ item: 'item-1', amount: 1 }] },
    setup: function () {
      seedState(this, runningState(THU_1200, 30));
    },
    test: async function () {
      const result = await this.runHook('on-kill', { eventData: { entity: 'zombieBoe', player: { gameId: this.pog.gameId } } });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerGiveItem).to.not.have.been.called;
    },
  }),

  // ---------- tick ----------
  createModuleTest({
    name: 'tick starts the default Friday 20:00 schedule',
    module: MODULE,
    now: FRI_2000,
    test: async function () {
      const result = await this.runCronJob('tick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const state = readState(this);
      expect(state.active).to.be.true;
      expect(state.source).to.equal('schedule');
      expect(state.multiplier).to.equal(2);
      expect(state.endsAt).to.equal('2026-11-06T22:00:00.000Z');
      expect(broadcasts(this)).to.deep.equal([
        'HAPPY HOUR! x2 rewards for the next 2h. Kill, play and earn bonus test coin! Type /happyhour for details.',
      ]);
    },
  }),

  createModuleTest({
    name: 'tick catches up a start minute missed by a late tick',
    module: MODULE,
    now: new Date(FRI_2000.getTime() + 3 * MIN),
    setup: function () {
      seedState(this, { active: false, lastTickAt: new Date(FRI_2000.getTime() - 1 * MIN).toISOString() });
    },
    test: async function () {
      await this.runCronJob('tick');
      const state = readState(this);
      expect(state.active).to.be.true;
      expect(state.startedAt).to.equal(FRI_2000.toISOString());
      expect(state.endsAt).to.equal('2026-11-06T22:00:00.000Z');
    },
  }),

  createModuleTest({
    name: 'tick evaluates schedules in the configured time zone',
    module: MODULE,
    // 20:00 UTC on 6 Nov = 21:00 in Berlin (CET).
    now: FRI_2000,
    userConfig: {
      timezone: 'Europe/Berlin',
      schedules: [{ cron: '0 21 * * fri', durationMinutes: 60, multiplier: 3 }],
    },
    test: async function () {
      await this.runCronJob('tick');
      const state = readState(this);
      expect(state.active).to.be.true;
      expect(state.multiplier).to.equal(3);
    },
  }),

  createModuleTest({
    name: 'tick does not start outside the schedule',
    module: MODULE,
    now: new Date(FRI_2000.getTime() + 60 * MIN),
    setup: function () {
      seedState(this, { active: false, lastTickAt: new Date(FRI_2000.getTime() + 59 * MIN).toISOString() });
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(readState(this).active).to.be.false;
      expect(this.messages).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'tick sends the heads-up before a scheduled start',
    module: MODULE,
    now: new Date(FRI_2000.getTime() - 15 * MIN),
    test: async function () {
      await this.runCronJob('tick');
      expect(broadcasts(this)).to.deep.equal(['Happy hour starts in 15 minutes: x2 rewards! Get online!']);
      expect(readState(this).active).to.be.false;
    },
  }),

  createModuleTest({
    name: 'tick skips invalid crons without failing',
    module: MODULE,
    now: FRI_2000,
    userConfig: {
      schedules: [
        { cron: 'every friday', durationMinutes: 60 },
        { cron: '0 20 * * 5', durationMinutes: 30 },
      ],
    },
    test: async function () {
      const result = await this.runCronJob('tick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(readState(this).endsAt).to.equal('2026-11-06T20:30:00.000Z');
    },
  }),

  createModuleTest({
    name: 'tick ends an expired event',
    module: MODULE,
    now: THU_1200,
    setup: function () {
      seedState(this, runningState(THU_1200, 0));
    },
    test: async function () {
      const result = await this.runCronJob('tick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(readState(this).active).to.be.false;
      expect(broadcasts(this)).to.deep.equal(['Happy hour is over. Thanks for playing!']);
    },
  }),

  createModuleTest({
    name: 'tick pays the playtime bonus to online players only',
    module: MODULE,
    now: THU_1200,
    currency: 0,
    otherPlayers: [{ name: 'Online friend' }, { name: 'Offline friend', online: false }],
    setup: function () {
      seedState(this, runningState(THU_1200, 30, 2, { lastPlaytimeAt: new Date(THU_1200.getTime() - 10 * MIN).toISOString() }));
    },
    test: async function () {
      const result = await this.runCronJob('tick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(10);
      expect(this.currency.balanceOf(this.otherPlayers[0].pog.playerId)).to.equal(10);
      expect(this.currency.balanceOf(this.otherPlayers[1].pog.playerId)).to.equal(0);
      expect(this.pms()).to.deep.equal(['+10 test coin happy hour playtime bonus (x2)']);
      expect(readState(this).lastPlaytimeAt).to.equal(THU_1200.toISOString());
    },
  }),

  createModuleTest({
    name: 'tick waits for the playtime interval',
    module: MODULE,
    now: THU_1200,
    currency: 0,
    setup: function () {
      seedState(this, runningState(THU_1200, 30, 2, { lastPlaytimeAt: new Date(THU_1200.getTime() - 9 * MIN).toISOString() }));
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(0);
    },
  }),

  createModuleTest({
    name: 'tick pays a 1-minute interval even when the cron fires a bit early, without drifting',
    module: MODULE,
    now: THU_1200,
    currency: 0,
    userConfig: { playtimeIntervalMinutes: 1 },
    setup: function () {
      // Last payout 59.6 s ago: the cron fired 400 ms early.
      seedState(this, runningState(THU_1200, 30, 2, { lastPlaytimeAt: new Date(THU_1200.getTime() - 59600).toISOString() }));
    },
    test: async function () {
      const result = await this.runCronJob('tick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(10);
      // The anchor moves one full interval, not to "now".
      expect(readState(this).lastPlaytimeAt).to.equal(new Date(THU_1200.getTime() + 400).toISOString());
    },
  }),

  createModuleTest({
    name: 'tick broadcasts a reminder on the interval',
    module: MODULE,
    now: THU_1200,
    userConfig: { playtimeBaseReward: 0 },
    setup: function () {
      seedState(this, runningState(THU_1200, 40, 2, { lastReminderAt: new Date(THU_1200.getTime() - 30 * MIN).toISOString() }));
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(broadcasts(this)).to.deep.equal(['Happy hour is on: x2 rewards, 40m left!']);
      expect(readState(this).lastReminderAt).to.equal(THU_1200.toISOString());
    },
  }),
];

describe('happy-hour (module-VM)', function () {
  tests.forEach((test) => {
    test.run();
  });
});
