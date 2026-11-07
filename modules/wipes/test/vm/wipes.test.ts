import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, single } from '@takaro/module-test';
import type { ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'wipes suite (module-VM)';

const NOW = new Date('2026-12-01T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const STATE_KEY = 'wipeReminders';
const DEFAULT_ANNOUNCEMENT = 'The server has been wiped. A new cycle starts now, good luck!';

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function lastWipe(ageMs: number, extra: Record<string, unknown> = {}) {
  return { id: 'wipe-1', createdAt: at(-ageMs), completedAt: at(-ageMs), ...extra };
}

function nextWipe(inMs: number, extra: Record<string, unknown> = {}) {
  return { wipeTypeId: 'type-1', wipeTypeName: 'Map wipe', at: at(inMs), timezone: 'UTC', ...extra };
}

function stubSummary(test: ModuleTest, summary: Record<string, unknown>) {
  test.client.stubs.wipe.wipeControllerSummary?.callsFake(async () => single(summary));
}

function reminderState(test: ModuleTest) {
  const rows = test.variables.all.filter((row) => row.key === STATE_KEY);
  expect(rows.length).to.be.lessThanOrEqual(1);
  expect(rows.every((row) => row.moduleId === test.moduleId && row.gameServerId === test.gameServerId)).to.be.true;
  return rows[0] ? JSON.parse(rows[0].value) : undefined;
}

function broadcasts(test: ModuleTest) {
  expect(test.messages.every((message) => message.recipientGameId === undefined)).to.be.true;
  return test.messages.map((message) => message.message);
}

function seedState(test: ModuleTest, state: unknown) {
  test.variables.insert({
    key: STATE_KEY,
    value: JSON.stringify(state),
    moduleId: test.moduleId,
    gameServerId: test.gameServerId,
  });
}

function formatted(iso: string, timeZone: string) {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

const NO_WIPES = ['No wipe has been recorded on this server yet.', 'No wipe is scheduled.'];

const commandTests = [
  createModuleTest({
    name: '/wipe with null last and next wipe',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { lastWipe: null, nextWipe: null });
    },
    test: async function () {
      const result = await this.runCommand('wipe');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(NO_WIPES);
    },
  }),
  createModuleTest({
    name: '/wipe with the summary keys omitted',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, {});
    },
    test: async function () {
      const result = await this.runCommand('wipe');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(NO_WIPES);
    },
  }),
  createModuleTest({
    name: '/wipe with a last wipe only',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { lastWipe: lastWipe(3 * DAY + 4 * HOUR, { wipeTypeName: 'Map wipe' }), nextWipe: null });
    },
    test: async function () {
      const result = await this.runCommand('wipe');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Last wipe: 3 days 4 hours ago (Map wipe).', 'No wipe is scheduled.']);
    },
  }),
  createModuleTest({
    name: '/wipe falls back to createdAt and omits a missing type name',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { lastWipe: { id: 'wipe-1', createdAt: at(-90 * MINUTE) }, nextWipe: null });
    },
    test: async function () {
      await this.runCommand('wipe');
      expect(this.pms()[0]).to.equal('Last wipe: 1 hour 30 minutes ago.');
    },
  }),
  createModuleTest({
    name: '/wipe with a next wipe only shows a countdown and the local time',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { lastWipe: null, nextWipe: nextWipe(2 * DAY + 3 * HOUR, { timezone: 'Europe/Brussels' }) });
    },
    test: async function () {
      await this.runCommand('wipe');
      const second = this.pms()[1];
      const when = formatted(at(2 * DAY + 3 * HOUR), 'Europe/Brussels');
      expect(second).to.equal(`Next wipe: in 2 days 3 hours, ${when} (Map wipe).`);
      expect(second).to.contain('16:00');
    },
  }),
  createModuleTest({
    name: '/wipe says due now for a next wipe in the past',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { lastWipe: null, nextWipe: nextWipe(-30_000) });
    },
    test: async function () {
      await this.runCommand('wipe');
      expect(this.pms()[1]).to.equal('Next wipe: due now (Map wipe).');
    },
  }),
  createModuleTest({
    name: '/wipe rounds 59 minutes 40 seconds up to an hour',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { lastWipe: null, nextWipe: nextWipe(59 * MINUTE + 40_000) });
    },
    test: async function () {
      await this.runCommand('wipe');
      expect(this.pms()[1]).to.contain('Next wipe: in 1 hour, ');
    },
  }),
  createModuleTest({
    name: '/wipe with both a last and a next wipe',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { lastWipe: lastWipe(DAY + 5 * MINUTE), nextWipe: nextWipe(6 * DAY) });
    },
    test: async function () {
      await this.runCommand('wipe');
      const pms = this.pms();
      expect(pms).to.have.length(2);
      expect(pms[0]).to.equal('Last wipe: 1 day ago.');
      expect(pms[1]).to.match(/^Next wipe: in 6 days, .+ \(Map wipe\)\.$/);
    },
  }),
];

const reminderTests = [
  createModuleTest({
    name: 'wipeReminder does nothing without a next wipe',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { lastWipe: null, nextWipe: null });
    },
    test: async function () {
      const result = await this.runCronJob('wipeReminder');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(broadcasts(this)).to.deep.equal([]);
      expect(this.variables.all).to.have.length(0);
    },
  }),
  createModuleTest({
    name: 'wipeReminder stays quiet when the wipe is beyond every offset',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { nextWipe: nextWipe(30 * HOUR) });
    },
    test: async function () {
      await this.runCronJob('wipeReminder');
      expect(broadcasts(this)).to.deep.equal([]);
      expect(this.variables.all).to.have.length(0);
    },
  }),
  createModuleTest({
    name: 'wipeReminder sends the 24 hour reminder once and records it',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { nextWipe: nextWipe(23 * HOUR) });
    },
    test: async function () {
      const result = await this.runCronJob('wipeReminder');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(broadcasts(this)).to.deep.equal([
        `The next server wipe is in 23 hours (${formatted(at(23 * HOUR), 'UTC')}).`,
      ]);
      expect(reminderState(this)).to.deep.equal({ at: at(23 * HOUR), sent: [1440] });
    },
  }),
  createModuleTest({
    name: 'wipeReminder does not repeat a reminder recorded as sent',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { nextWipe: nextWipe(23 * HOUR) });
      seedState(this, { at: at(23 * HOUR), sent: [1440] });
    },
    test: async function () {
      await this.runCronJob('wipeReminder');
      expect(broadcasts(this)).to.deep.equal([]);
      expect(reminderState(this)).to.deep.equal({ at: at(23 * HOUR), sent: [1440] });
    },
  }),
  createModuleTest({
    name: 'wipeReminder sends once across two runs',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { nextWipe: nextWipe(23 * HOUR) });
    },
    test: async function () {
      await this.runCronJob('wipeReminder');
      await this.runCronJob('wipeReminder');
      expect(broadcasts(this)).to.have.length(1);
    },
  }),
  createModuleTest({
    name: 'wipeReminder sends the 60 minute reminder after the 24 hour one',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { nextWipe: nextWipe(50 * MINUTE) });
      seedState(this, { at: at(50 * MINUTE), sent: [1440] });
    },
    test: async function () {
      await this.runCronJob('wipeReminder');
      expect(broadcasts(this)).to.deep.equal([
        `The next server wipe is in 50 minutes (${formatted(at(50 * MINUTE), 'UTC')}).`,
      ]);
      expect(reminderState(this).sent).to.deep.equal([1440, 60]);
    },
  }),
  createModuleTest({
    name: 'wipeReminder sends one message when several offsets were crossed',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { nextWipe: nextWipe(5 * MINUTE) });
    },
    test: async function () {
      await this.runCronJob('wipeReminder');
      expect(broadcasts(this)).to.deep.equal(['The server wipes in 5 minutes!']);
      expect(reminderState(this).sent).to.have.members([1440, 60, 10]);
    },
  }),
  createModuleTest({
    name: 'wipeReminder re-arms for a different scheduled wipe',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { nextWipe: nextWipe(23 * HOUR) });
      seedState(this, { at: at(-DAY), sent: [1440, 60, 10] });
    },
    test: async function () {
      await this.runCronJob('wipeReminder');
      expect(broadcasts(this)).to.have.length(1);
      expect(reminderState(this)).to.deep.equal({ at: at(23 * HOUR), sent: [1440] });
    },
  }),
  createModuleTest({
    name: 'wipeReminder honours configured offsets and message',
    module: MODULE,
    now: NOW,
    userConfig: { reminders: [{ minutesBefore: 120, message: '{wipeType} in {timeLeft}' }] },
    setup: function () {
      stubSummary(this, { nextWipe: nextWipe(90 * MINUTE) });
    },
    test: async function () {
      await this.runCronJob('wipeReminder');
      expect(broadcasts(this)).to.deep.equal(['Map wipe in 1 hour 30 minutes']);
    },
  }),
  createModuleTest({
    name: 'wipeReminder is off with an empty reminder list',
    module: MODULE,
    now: NOW,
    userConfig: { reminders: [] },
    setup: function () {
      stubSummary(this, { nextWipe: nextWipe(5 * MINUTE) });
    },
    test: async function () {
      await this.runCronJob('wipeReminder');
      expect(broadcasts(this)).to.deep.equal([]);
      expect(this.variables.all).to.have.length(0);
    },
  }),
  createModuleTest({
    name: 'wipeReminder ignores a wipe in the past',
    module: MODULE,
    now: NOW,
    setup: function () {
      stubSummary(this, { nextWipe: nextWipe(-MINUTE) });
    },
    test: async function () {
      await this.runCronJob('wipeReminder');
      expect(broadcasts(this)).to.deep.equal([]);
    },
  }),
];

const announcementTests = [
  createModuleTest({
    name: 'wipeAnnouncement broadcasts the default message',
    module: MODULE,
    now: NOW,
    test: async function () {
      const result = await this.runHook('wipeAnnouncement', {
        withPlayer: false,
        eventData: { wipeId: 'wipe-1', trigger: 'manual', steps: [] },
      });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(broadcasts(this)).to.deep.equal([DEFAULT_ANNOUNCEMENT]);
    },
  }),
  createModuleTest({
    name: 'wipeAnnouncement fills the type name and note placeholders',
    module: MODULE,
    now: NOW,
    userConfig: { announcementMessage: '{wipeType} done! {note}' },
    test: async function () {
      await this.runHook('wipeAnnouncement', {
        withPlayer: false,
        eventData: { wipeId: 'wipe-1', trigger: 'schedule', steps: [], wipeTypeName: 'Map wipe', note: 'New seed' },
      });
      expect(broadcasts(this)).to.deep.equal(['Map wipe done! New seed']);
    },
  }),
  createModuleTest({
    name: 'wipeAnnouncement collapses missing placeholders',
    module: MODULE,
    now: NOW,
    userConfig: { announcementMessage: '{wipeType} done! {note}' },
    test: async function () {
      await this.runHook('wipeAnnouncement', {
        withPlayer: false,
        eventData: { wipeId: 'wipe-1', trigger: 'manual', steps: [] },
      });
      expect(broadcasts(this)).to.deep.equal(['done!']);
    },
  }),
  createModuleTest({
    name: 'wipeAnnouncement keeps dollar signs in the note literal',
    module: MODULE,
    now: NOW,
    userConfig: { announcementMessage: 'Wiped! {note}' },
    test: async function () {
      await this.runHook('wipeAnnouncement', {
        withPlayer: false,
        eventData: { wipeId: 'wipe-1', trigger: 'manual', steps: [], note: 'costs $$5 $&' },
      });
      expect(broadcasts(this)).to.deep.equal(['Wiped! costs $$5 $&']);
    },
  }),
];

const tests = [...commandTests, ...reminderTests, ...announcementTests];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
