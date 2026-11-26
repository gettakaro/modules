import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, single } from '@takaro/module-test';
import type { ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const STATE_KEY = 'restart_manager_state';
const PVP_KEY = 'restart_manager_last_pvp';
const MIN = 60 * 1000;

// Default schedule: every day 04:00 UTC.
const AT_0400 = new Date('2026-11-26T04:00:00.000Z');
const at = (minutesFrom0400: number, seconds = 0) => new Date(AT_0400.getTime() + minutesFrom0400 * MIN + seconds * 1000);
const iso = (d: Date) => d.toISOString();

function seedState(t: ModuleTest, state: Record<string, unknown>) {
  t.variables.insert({ key: STATE_KEY, value: JSON.stringify(state), gameServerId: t.gameServerId, moduleId: t.moduleId });
}

function readState(t: ModuleTest) {
  const rows = t.variables.all.filter(
    (row) => row.key === STATE_KEY && row.gameServerId === t.gameServerId && row.moduleId === t.moduleId,
  );
  expect(rows).to.have.length(1);
  return JSON.parse(rows[0].value);
}

function countdown(extra: Record<string, unknown> = {}) {
  return {
    pending: {
      id: `schedule-${AT_0400.getTime()}`,
      at: iso(AT_0400),
      originalAt: iso(AT_0400),
      source: 'schedule',
      by: null,
      warned: [30, 15, 5, 1],
      forced: false,
      postponed: null,
      ...extra,
    },
    lastScheduledAt: iso(AT_0400),
  };
}

const broadcasts = (t: ModuleTest) => t.messages.filter((m) => m.recipientGameId === undefined).map((m) => m.message);
const consoleCommands = (t: ModuleTest) =>
  t.client.stubs.gameserver.gameServerControllerExecuteCommand!.getCalls().map((c) => (c.args[1] as { command: string }).command);

/** Pretend to be a 7 Days to Die server whose console answers with these outputs. */
function as7d2d(t: ModuleTest, outputs: Record<string, string>) {
  t.client.stubs.gameserver.gameServerControllerGetOne?.callsFake(async (id: string) =>
    single({ id, name: 'Test server', type: 'SEVENDAYSTODIE', connectionInfo: '{}', reachable: true, enabled: true }),
  );
  t.client.stubs.gameserver.gameServerControllerExecuteCommand?.callsFake(async (_id: string, body?: { command?: string }) =>
    single({ rawResult: outputs[body?.command ?? ''] ?? '', success: true }),
  );
}

const tests = [
  // ---------- restartstatus ----------
  createModuleTest({
    name: 'status shows the time until the next scheduled restart',
    module: MODULE,
    now: at(-185),
    permissions: [],
    test: async function () {
      const result = await this.runCommand('restartstatus');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Next server restart in 3 hours 5 minutes.']);
    },
  }),

  createModuleTest({
    name: 'status says nothing is scheduled when there are no restart times',
    module: MODULE,
    userConfig: { schedules: [] },
    test: async function () {
      await this.runCommand('restartstatus');
      expect(this.pms()).to.deep.equal(['No server restart is scheduled.']);
    },
  }),

  createModuleTest({
    name: 'status during a countdown',
    module: MODULE,
    now: at(-12),
    setup: function () {
      seedState(this, countdown({ warned: [30, 15] }));
    },
    test: async function () {
      await this.runCommand('restartstatus');
      expect(this.pms()).to.deep.equal(['The server restarts in 12 minutes.']);
    },
  }),

  createModuleTest({
    name: 'status while on hold shows the reason and the latest time',
    module: MODULE,
    now: at(10),
    setup: function () {
      seedState(this, countdown({ postponed: { since: iso(at(0)), reason: 'blood moon', lastCheckAt: iso(at(10)) } }));
    },
    test: async function () {
      await this.runCommand('restartstatus');
      // 04:00 + 60 max delay + 5 countdown - 04:10 = 55 min
      expect(this.pms()).to.deep.equal([
        'The server restart is on hold: blood moon. It runs when it is safe, at the latest in about 55 minutes.',
      ]);
    },
  }),

  createModuleTest({
    name: 'status honours the time zone',
    module: MODULE,
    // 01:00 UTC = 02:00 in Berlin (CET); next 04:00 Berlin = 03:00 UTC
    now: at(-180),
    userConfig: { timezone: 'Europe/Berlin' },
    test: async function () {
      await this.runCommand('restartstatus');
      expect(this.pms()).to.deep.equal(['Next server restart in 2 hours.']);
    },
  }),

  // ---------- tick: countdown ----------
  createModuleTest({
    name: 'tick does nothing before the first warning',
    module: MODULE,
    now: at(-31),
    test: async function () {
      const result = await this.runCronJob('tick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.have.length(0);
      expect(readState(this).pending).to.equal(null);
    },
  }),

  createModuleTest({
    name: 'tick starts the countdown 30 minutes before a scheduled restart',
    module: MODULE,
    now: at(-30, 2),
    test: async function () {
      const result = await this.runCronJob('tick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(broadcasts(this)).to.deep.equal(['Server restart in 30 minutes. Find a safe spot and log out in time.']);
      const state = readState(this);
      expect(state.pending.at).to.equal(iso(AT_0400));
      expect(state.pending.warned).to.deep.equal([30]);
      expect(state.lastScheduledAt).to.equal(iso(AT_0400));
      expect(this.client.stubs.discord.discordControllerSendMessage).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'first warning also goes to Discord when a channel is set',
    module: MODULE,
    now: at(-30),
    userConfig: { discordChannelId: '999' },
    test: async function () {
      await this.runCronJob('tick');
      expect(this.client.stubs.discord.discordControllerSendMessage).to.have.been.calledOnceWith('999', {
        message: 'Server restart in 30 minutes. Find a safe spot and log out in time.',
      });
    },
  }),

  createModuleTest({
    name: 'tick sends each warning once, then nothing between warnings',
    module: MODULE,
    now: at(-15),
    setup: function () {
      seedState(this, countdown({ warned: [30] }));
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(broadcasts(this)).to.deep.equal(['Server restart in 15 minutes. Find a safe spot and log out in time.']);
      expect(readState(this).pending.warned).to.deep.equal([30, 15]);
      await this.runCronJob('tick');
      expect(broadcasts(this)).to.have.length(1);
    },
  }),

  createModuleTest({
    name: 'tick sends the 1 minute warning with singular text',
    module: MODULE,
    now: at(-1, 5),
    setup: function () {
      seedState(this, countdown({ warned: [30, 15, 5] }));
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(broadcasts(this)).to.deep.equal(['Server restart in 1 minute. Find a safe spot and log out in time.']);
    },
  }),

  createModuleTest({
    name: 'restart: broadcast, then Takaro shutdown by default (no save command for other games)',
    module: MODULE,
    now: at(0, 3),
    setup: function () {
      seedState(this, countdown());
    },
    test: async function () {
      const result = await this.runCronJob('tick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(broadcasts(this)).to.deep.equal(['The server is restarting now. See you in a few minutes!']);
      expect(this.client.stubs.gameserver.gameServerControllerShutdown).to.have.been.calledOnceWith(this.gameServerId);
      expect(consoleCommands(this)).to.deep.equal([]);
      expect(this.client.stubs.gameserver.gameServerControllerKickPlayer).to.not.have.been.called;
      const state = readState(this);
      expect(state.pending).to.equal(null);
      expect(state.lastRestartAt).to.equal(iso(at(0, 3)));
    },
  }),

  createModuleTest({
    name: 'restart on 7 Days to Die saves with saveworld, kicks everyone, then uses Takaro shutdown',
    module: MODULE,
    now: at(0),
    userConfig: { kickAllBeforeShutdown: true, bloodMoonDelay: false },
    otherPlayers: [{ name: 'Online friend' }, { name: 'Offline friend', online: false }],
    setup: function () {
      seedState(this, countdown());
      as7d2d(this, {});
    },
    test: async function () {
      const result = await this.runCronJob('tick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(consoleCommands(this)).to.deep.equal(['saveworld']);
      const kicked = this.client.stubs.gameserver.gameServerControllerKickPlayer!.getCalls().map((c) => c.args[1]);
      expect(kicked).to.have.members([this.pog.playerId, this.otherPlayers[0].pog.playerId]);
      expect(this.client.stubs.gameserver.gameServerControllerKickPlayer!.firstCall.args[2]).to.deep.equal({
        reason: 'Server restart. Please reconnect in a few minutes.',
      });
      expect(this.client.stubs.gameserver.gameServerControllerShutdown).to.have.been.calledOnce;
    },
  }),

  createModuleTest({
    name: 'a configured shutdown command replaces Takaro shutdown; save can be turned off',
    module: MODULE,
    now: at(0),
    userConfig: {
      saveBeforeShutdown: false,
      gameCommands: { other: { saveCommand: 'save', shutdownCommand: 'quit' } },
    },
    setup: function () {
      seedState(this, countdown());
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(consoleCommands(this)).to.deep.equal(['quit']);
      expect(this.client.stubs.gameserver.gameServerControllerShutdown).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'no warnings configured: the restart runs at the scheduled minute',
    module: MODULE,
    now: at(0, 4),
    userConfig: { warningMinutes: [] },
    test: async function () {
      await this.runCronJob('tick');
      expect(broadcasts(this)).to.deep.equal(['The server is restarting now. See you in a few minutes!']);
      expect(this.client.stubs.gameserver.gameServerControllerShutdown).to.have.been.calledOnce;
    },
  }),

  createModuleTest({
    name: 'a scheduled restart too soon after the last restart is skipped',
    module: MODULE,
    now: at(-30),
    setup: function () {
      seedState(this, { pending: null, lastRestartAt: iso(at(-40)) });
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(this.messages).to.have.length(0);
      const state = readState(this);
      expect(state.pending).to.equal(null);
      expect(state.lastScheduledAt).to.equal(iso(AT_0400));
    },
  }),

  createModuleTest({
    name: 'an overdue countdown (server was down) is dropped, not run late',
    module: MODULE,
    now: at(20),
    setup: function () {
      seedState(this, countdown());
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(this.client.stubs.gameserver.gameServerControllerShutdown).to.not.have.been.called;
      expect(readState(this).pending).to.equal(null);
    },
  }),

  // ---------- safe window ----------
  createModuleTest({
    name: '7D2D blood moon (BloodMoonDay stat) puts the restart on hold',
    module: MODULE,
    now: at(0),
    setup: function () {
      seedState(this, countdown());
      as7d2d(this, { gettime: 'Day 14, 22:30', 'ggs BloodMoonDay': 'GameStat.BloodMoonDay = 14' });
    },
    test: async function () {
      const result = await this.runCronJob('tick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(broadcasts(this)).to.deep.equal(['The server restart is on hold: blood moon. It runs when it is safe.']);
      expect(this.client.stubs.gameserver.gameServerControllerShutdown).to.not.have.been.called;
      const state = readState(this);
      expect(state.pending.postponed.reason).to.equal('blood moon');
    },
  }),

  createModuleTest({
    name: '7D2D blood moon also covers the early morning after',
    module: MODULE,
    now: at(-30),
    setup: function () {
      as7d2d(this, { gettime: 'Day 15, 03:10', 'ggs BloodMoonDay': 'GameStat.BloodMoonDay = 14' });
    },
    test: async function () {
      await this.runCronJob('tick');
      // Hold at the first warning: players never see a countdown that will not happen.
      expect(broadcasts(this)).to.deep.equal(['The server restart is on hold: blood moon. It runs when it is safe.']);
    },
  }),

  createModuleTest({
    name: '7D2D blood moon falls back to every N days without the game stat',
    module: MODULE,
    now: at(0),
    setup: function () {
      seedState(this, countdown());
      as7d2d(this, { gettime: 'Day 21, 21:00' });
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(readState(this).pending.postponed.reason).to.equal('blood moon');
    },
  }),

  createModuleTest({
    name: '7D2D normal day: the restart runs',
    module: MODULE,
    now: at(0),
    setup: function () {
      seedState(this, countdown());
      as7d2d(this, { gettime: 'Day 14, 12:00', 'ggs BloodMoonDay': 'GameStat.BloodMoonDay = 14' });
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(this.client.stubs.gameserver.gameServerControllerShutdown).to.have.been.calledOnce;
      expect(consoleCommands(this)).to.deep.equal(['gettime', 'ggs BloodMoonDay', 'saveworld']);
    },
  }),

  createModuleTest({
    name: 'unreadable game time does not block the restart',
    module: MODULE,
    now: at(0),
    setup: function () {
      seedState(this, countdown());
      as7d2d(this, { gettime: 'Unknown command' });
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(this.client.stubs.gameserver.gameServerControllerShutdown).to.have.been.calledOnce;
    },
  }),

  createModuleTest({
    name: 'blood moon check only runs on 7 Days to Die',
    module: MODULE,
    now: at(0),
    setup: function () {
      seedState(this, countdown());
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(consoleCommands(this)).to.not.include('gettime');
      expect(this.client.stubs.gameserver.gameServerControllerShutdown).to.have.been.calledOnce;
    },
  }),

  createModuleTest({
    name: 'players online threshold puts the restart on hold',
    module: MODULE,
    now: at(-5),
    userConfig: { delayWhenPlayersOnline: 2 },
    otherPlayers: [{ name: 'Friend' }],
    setup: function () {
      seedState(this, countdown({ warned: [30, 15] }));
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(broadcasts(this)).to.deep.equal(['The server restart is on hold: 2 players online. It runs when it is safe.']);
    },
  }),

  createModuleTest({
    name: 'PvP kill is remembered by the hook and holds the restart',
    module: MODULE,
    now: at(0),
    userConfig: { pvpQuietMinutes: 10 },
    otherPlayers: [{ name: 'Killer' }],
    setup: function () {
      seedState(this, countdown());
    },
    test: async function () {
      const hook = await this.runHook('on-player-death', {
        eventType: 'player-death',
        eventData: { player: { gameId: this.pog.gameId }, attacker: { gameId: this.otherPlayers[0].pog.gameId, name: 'Killer' } },
      });
      expect(hook.success, JSON.stringify(hook.logs)).to.be.true;
      expect(this.variables.all.filter((v) => v.key === PVP_KEY)).to.have.length(1);
      await this.runCronJob('tick');
      expect(broadcasts(this)).to.deep.equal([
        'The server restart is on hold: a PvP fight in the last 10 minutes. It runs when it is safe.',
      ]);
    },
  }),

  createModuleTest({
    name: 'PvE deaths and disabled PvP check are ignored by the hook',
    module: MODULE,
    userConfig: { pvpQuietMinutes: 10 },
    test: async function () {
      await this.runHook('on-player-death', { eventType: 'player-death', eventData: { player: { gameId: this.pog.gameId } } });
      await this.runHook('on-player-death', {
        eventType: 'player-death',
        eventData: { player: { gameId: this.pog.gameId }, attacker: { gameId: this.pog.gameId } },
      });
      expect(this.variables.all).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'an old PvP kill does not hold the restart',
    module: MODULE,
    now: at(0),
    userConfig: { pvpQuietMinutes: 10 },
    setup: function () {
      seedState(this, countdown());
      this.variables.insert({ key: PVP_KEY, value: iso(at(-11)), gameServerId: this.gameServerId, moduleId: this.moduleId });
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(this.client.stubs.gameserver.gameServerControllerShutdown).to.have.been.calledOnce;
    },
  }),

  createModuleTest({
    name: 'console check: holds while the output matches the pattern',
    module: MODULE,
    now: at(0),
    userConfig: { consoleConditions: [{ command: 'status', pattern: 'raid\\s+active', reason: 'a raid is running' }] },
    setup: function () {
      seedState(this, countdown());
      this.client.stubs.gameserver.gameServerControllerExecuteCommand?.callsFake(async () =>
        single({ rawResult: 'Raid ACTIVE on base 3', success: true }),
      );
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(broadcasts(this)).to.deep.equal(['The server restart is on hold: a raid is running. It runs when it is safe.']);
    },
  }),

  createModuleTest({
    name: 'console check: an invalid pattern is skipped, not fatal',
    module: MODULE,
    now: at(0),
    userConfig: { consoleConditions: [{ command: 'status', pattern: '([', reason: 'x' }] },
    setup: function () {
      seedState(this, countdown());
    },
    test: async function () {
      const result = await this.runCronJob('tick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerShutdown).to.have.been.calledOnce;
    },
  }),

  createModuleTest({
    name: 'max delay 0 turns all safe-window checks off',
    module: MODULE,
    now: at(0),
    userConfig: { maxDelayMinutes: 0, delayWhenPlayersOnline: 1 },
    setup: function () {
      seedState(this, countdown());
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(this.client.stubs.gameserver.gameServerControllerShutdown).to.have.been.calledOnce;
    },
  }),

  createModuleTest({
    name: 'on hold: no check before the interval is over',
    module: MODULE,
    now: at(13),
    userConfig: { delayWhenPlayersOnline: 1 },
    setup: function () {
      seedState(this, countdown({ postponed: { since: iso(at(0)), reason: '1 players online', lastCheckAt: iso(at(10)) } }));
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(this.messages).to.have.length(0);
      expect(readState(this).pending.postponed.lastCheckAt).to.equal(iso(at(10)));
    },
  }),

  createModuleTest({
    name: 'on hold: still unsafe after the interval keeps waiting quietly',
    module: MODULE,
    now: at(15),
    userConfig: { delayWhenPlayersOnline: 1 },
    setup: function () {
      seedState(this, countdown({ postponed: { since: iso(at(0)), reason: 'old', lastCheckAt: iso(at(10)) } }));
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(this.messages).to.have.length(0);
      const state = readState(this);
      expect(state.pending.postponed.lastCheckAt).to.equal(iso(at(15)));
      expect(state.pending.postponed.reason).to.equal('1 players online');
    },
  }),

  createModuleTest({
    name: 'on hold: safe again resumes with a 5 minute countdown',
    module: MODULE,
    now: at(15),
    setup: function () {
      seedState(this, countdown({ postponed: { since: iso(at(0)), reason: 'blood moon', lastCheckAt: iso(at(10)) } }));
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(broadcasts(this)).to.deep.equal(['Server restart in 5 minutes. Find a safe spot and log out in time.']);
      const state = readState(this);
      expect(state.pending.postponed).to.equal(null);
      expect(state.pending.at).to.equal(iso(at(20)));
      expect(state.pending.warned).to.deep.equal([30, 15, 5]);
    },
  }),

  createModuleTest({
    name: 'on hold: max delay reached forces the restart with a countdown',
    module: MODULE,
    now: at(60),
    userConfig: { delayWhenPlayersOnline: 1 },
    setup: function () {
      seedState(this, countdown({ postponed: { since: iso(at(0)), reason: 'blood moon', lastCheckAt: iso(at(55)) } }));
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(broadcasts(this)).to.deep.equal([
        'The server restart can not wait any longer (blood moon). Restart in 5 minutes.',
      ]);
      const state = readState(this);
      expect(state.pending.forced).to.be.true;
      expect(state.pending.at).to.equal(iso(at(65)));
    },
  }),

  createModuleTest({
    name: 'forced countdown skips safety checks and restarts',
    module: MODULE,
    now: at(65),
    userConfig: { delayWhenPlayersOnline: 1 },
    setup: function () {
      seedState(this, countdown({ at: iso(at(65)), forced: true }));
    },
    test: async function () {
      await this.runCronJob('tick');
      expect(this.client.stubs.gameserver.gameServerControllerShutdown).to.have.been.calledOnce;
    },
  }),

  // ---------- admin commands ----------
  createModuleTest({
    name: 'restartnow without permission is refused',
    module: MODULE,
    permissions: [],
    test: async function () {
      const result = await this.runCommand('restartnow', { minutes: 5 });
      expect(this.userError(result)).to.equal(
        'Only admins can restart the server. Type /restartstatus to see when the next restart is.',
      );
      expect(this.messages).to.have.length(0);
      expect(this.client.stubs.gameserver.gameServerControllerShutdown).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'restartnow 10 starts a forced countdown with the right warnings left',
    module: MODULE,
    now: at(-200),
    permissions: [{ permission: 'RESTART_MANAGER_MANAGE' }],
    test: async function () {
      const result = await this.runCommand('restartnow', { minutes: 10 });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(broadcasts(this)).to.deep.equal(['Server restart in 10 minutes. Find a safe spot and log out in time.']);
      expect(this.pms()).to.deep.equal(['Restart set: in 10 min. Type /restartcancel to stop it.']);
      const state = readState(this);
      expect(state.pending.source).to.equal('admin');
      expect(state.pending.forced).to.be.true;
      expect(state.pending.at).to.equal(iso(at(-190)));
      expect(state.pending.warned).to.deep.equal([30, 15]);
    },
  }),

  createModuleTest({
    name: 'restartnow uses 5 minutes by default',
    module: MODULE,
    now: at(-200),
    test: async function () {
      await this.runCommand('restartnow');
      expect(broadcasts(this)).to.deep.equal(['Server restart in 5 minutes. Find a safe spot and log out in time.']);
    },
  }),

  createModuleTest({
    name: 'restartnow 0 restarts right away',
    module: MODULE,
    now: at(-200),
    test: async function () {
      const result = await this.runCommand('restartnow', { minutes: 0 });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Restarting the server now.']);
      expect(broadcasts(this)).to.deep.equal(['The server is restarting now. See you in a few minutes!']);
      expect(this.client.stubs.gameserver.gameServerControllerShutdown).to.have.been.calledOnce;
      expect(readState(this).lastRestartAt).to.equal(iso(at(-200)));
    },
  }),

  createModuleTest({
    name: 'restartnow rejects bad minutes',
    module: MODULE,
    test: async function () {
      const neg = await this.runCommand('restartnow', { minutes: -3 });
      expect(this.userError(neg)).to.equal('Usage: /restartnow <minutes 0-1440>. 0 restarts right away.');
      const big = await this.runCommand('restartnow', { minutes: 5000 });
      expect(this.userError(big)).to.equal('Usage: /restartnow <minutes 0-1440>. 0 restarts right away.');
      const frac = await this.runCommand('restartnow', { minutes: 2.5 });
      expect(this.userError(frac)).to.equal('Usage: /restartnow <minutes 0-1440>. 0 restarts right away.');
    },
  }),

  createModuleTest({
    name: 'restartnow replaces a running countdown',
    module: MODULE,
    now: at(-12),
    setup: function () {
      seedState(this, countdown({ warned: [30, 15] }));
    },
    test: async function () {
      await this.runCommand('restartnow', { minutes: 2 });
      expect(this.pms()).to.deep.equal(['Restart moved: in 2 min. Type /restartcancel to stop it.']);
      expect(readState(this).pending.at).to.equal(iso(at(-10)));
    },
  }),

  createModuleTest({
    name: 'restartcancel stops a countdown players were warned about',
    module: MODULE,
    now: at(-12),
    setup: function () {
      seedState(this, countdown({ warned: [30, 15] }));
    },
    test: async function () {
      const result = await this.runCommand('restartcancel');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(broadcasts(this)).to.deep.equal(['The planned server restart was cancelled.']);
      expect(this.pms()).to.deep.equal(['Restart cancelled.']);
      expect(readState(this).pending).to.equal(null);
      // The cancelled scheduled restart does not come back on the next tick.
      await this.runCronJob('tick');
      expect(readState(this).pending).to.equal(null);
      expect(broadcasts(this)).to.have.length(1);
    },
  }),

  createModuleTest({
    name: 'restartcancel after restartnow above every warning still tells everyone',
    module: MODULE,
    now: at(-200),
    test: async function () {
      // 45 min is above every default warning, so no warning is marked as sent yet.
      await this.runCommand('restartnow', { minutes: 45 });
      await this.runCommand('restartcancel');
      expect(broadcasts(this)).to.deep.equal([
        'Server restart in 45 minutes. Find a safe spot and log out in time.',
        'The planned server restart was cancelled.',
      ]);
    },
  }),

  createModuleTest({
    name: 'restartcancel with nothing counting down skips the next scheduled restart',
    module: MODULE,
    now: at(-120),
    test: async function () {
      await this.runCommand('restartcancel');
      expect(this.pms()).to.deep.equal(['Skipped the next scheduled restart (it was due in 2 hours).']);
      expect(this.messages.filter((m) => m.recipientGameId === undefined)).to.have.length(0);
      await this.runCommand('restartstatus');
      expect(this.pms()[1]).to.equal('Next server restart in 1 day 2 hours.');
    },
  }),

  createModuleTest({
    name: 'restartcancel without permission is refused',
    module: MODULE,
    permissions: [],
    userConfig: { schedules: [] },
    test: async function () {
      const denied = await this.runCommand('restartcancel');
      expect(this.userError(denied)).to.equal(
        'Only admins can cancel a restart. Type /restartstatus to see when the next restart is.',
      );
    },
  }),

  createModuleTest({
    name: 'restartcancel with nothing planned says so',
    module: MODULE,
    userConfig: { schedules: [] },
    test: async function () {
      const result = await this.runCommand('restartcancel');
      expect(this.userError(result)).to.equal('No restart is planned, so there is nothing to cancel.');
    },
  }),

  createModuleTest({
    name: 'invalid cron entries are skipped, valid ones still work',
    module: MODULE,
    now: at(-30),
    userConfig: { schedules: ['not a cron', '0 4 * * *'] },
    test: async function () {
      const result = await this.runCronJob('tick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(broadcasts(this)).to.have.length(1);
    },
  }),
];

describe('restart-manager (module-VM)', function () {
  tests.forEach((test) => {
    test.run();
  });
});
