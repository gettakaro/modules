import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const FROZEN = new Date('2024-06-01T12:00:00.000Z');
const STAFF_POS = { x: 100, y: 50, z: 100, dimension: 'overworld' };
const PRISONER_POS = { x: 900, y: 60, z: -400, dimension: 'overworld' };
const JAILED_ROLE = '11111111-1111-4111-8111-111111111111';

// Chat delivery of TakaroUserError happens outside the VM, so error cases assert `this.userError(result)`.

type Row = { id: string; key: string; value: string; playerId?: string | null };

function record(t: { variables: { all: Row[] } }) {
  const row = t.variables.all.find((r) => r.key === 'jail_record');
  return row ? { row, value: JSON.parse(row.value) } : null;
}

const staff = {
  module: MODULE,
  now: FROZEN,
  permissions: [{ permission: 'JAIL_MANAGE' }],
  player: { name: 'Staff', position: STAFF_POS },
  otherPlayers: [{ name: 'Prisoner', position: PRISONER_POS }],
};

const tests = [
  createModuleTest({
    ...staff,
    name: 'staff without JAIL_MANAGE is refused',
    permissions: [],
    test: async function () {
      const result = await this.runCommand('setjail');
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You do not have permission to manage the jail.');
    },
  }),

  createModuleTest({
    ...staff,
    name: 'jail needs a jail spot first',
    test: async function () {
      const result = await this.runCommand('jail', { target: this.otherPlayers[0].pog, minutes: 10, reason: 'griefing' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('No jail set yet. Stand in the jail and use /setjail first.');
    },
  }),

  createModuleTest({
    ...staff,
    name: 'setjail, jail, jailed and jailtime work end to end',
    userConfig: { jailedRoleId: JAILED_ROLE },
    test: async function () {
      const set = await this.runCommand('setjail');
      expect(set.success, JSON.stringify(set.logs)).to.be.true;

      const prisoner = this.otherPlayers[0];
      const jail = await this.runCommand('jail', { target: prisoner.pog, minutes: 90, reason: 'griefing' });
      expect(jail.success, JSON.stringify(jail.logs)).to.be.true;

      const tp = this.client.stubs.gameserver.gameServerControllerTeleportPlayer;
      expect(tp).to.have.been.calledOnce;
      expect(tp?.firstCall.args[1]).to.equal(prisoner.pog.playerId);
      expect(tp?.firstCall.args[2]).to.deep.equal({ x: 100, y: 50, z: 100, dimension: 'overworld' });

      const assign = this.client.stubs.player.playerControllerAssignRole;
      expect(assign?.firstCall.args[0]).to.equal(prisoner.pog.playerId);
      expect(assign?.firstCall.args[1]).to.equal(JAILED_ROLE);

      const rec = record(this)!;
      expect(rec.row.playerId).to.equal(prisoner.pog.playerId);
      expect(rec.value.until).to.equal('2024-06-01T13:30:00.000Z');
      expect(rec.value.returnTo).to.deep.equal(PRISONER_POS);
      expect(rec.value.reason).to.equal('griefing');

      expect(this.client.pmsTo(prisoner.pog.gameId)).to.deep.equal([
        'You have been jailed for 1h 30m. Reason: griefing. Type /jailtime to see time left.',
      ]);

      const again = await this.runCommand('jail', { target: prisoner.pog, minutes: 5, reason: 'x' });
      expect(again.success).to.be.false;
      expect(this.userError(again)).to.equal('Prisoner is already jailed (1h 30m left). Use /unjail Prisoner first.');

      const list = await this.runCommand('jailed');
      expect(list.success, JSON.stringify(list.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Jail set at 100, 50, 100.',
        'Prisoner jailed for 1h 30m.',
        'In jail (1):',
        '- Prisoner: 1h 30m left. Reason: griefing (by Staff)',
      ]);
    },
  }),

  createModuleTest({
    ...staff,
    name: 'jailtime tells a free player they are not in jail',
    permissions: [],
    test: async function () {
      const result = await this.runCommand('jailtime');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['You are not in jail.']);
    },
  }),

  createModuleTest({
    module: MODULE,
    now: FROZEN,
    name: 'jailtime shows remaining time to the jailed player',
    permissions: [],
    player: { name: 'Prisoner' },
    setup: function () {
      this.variables.create({
        key: 'jail_record',
        value: JSON.stringify({
          status: 'jailed',
          name: 'Prisoner',
          reason: 'spam',
          by: 'Staff',
          startedAt: FROZEN.toISOString(),
          until: '2024-06-01T12:25:00.000Z',
          returnTo: null,
          roleId: null,
        }),
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
        playerId: this.pog.playerId,
      });
    },
    test: async function () {
      const result = await this.runCommand('jailtime');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['You are in jail: 25m left. Reason: spam']);
    },
  }),

  createModuleTest({
    ...staff,
    name: 'rejects bad minutes and too long sentences',
    userConfig: { maxMinutes: 60 },
    test: async function () {
      await this.runCommand('setjail');
      const neg = await this.runCommand('jail', { target: this.otherPlayers[0].pog, minutes: -1, reason: 'x' });
      expect(this.userError(neg)).to.equal('Minutes must be a whole number of 0 or more. Usage: /jail <player> <minutes> <reason>');
      const long = await this.runCommand('jail', { target: this.otherPlayers[0].pog, minutes: 61, reason: 'x' });
      expect(this.userError(long)).to.equal('The maximum jail time is 60 minutes.');
      expect(this.client.stubs.gameserver.gameServerControllerTeleportPlayer).to.not.have.been.called;
    },
  }),

  createModuleTest({
    ...staff,
    name: 'fails gracefully when the game cannot teleport, and jails nobody',
    setup: function () {
      this.client.stubs.gameserver.gameServerControllerTeleportPlayer?.callsFake(async () => {
        throw new Error('Not implemented by connector');
      });
    },
    test: async function () {
      await this.runCommand('setjail');
      const result = await this.runCommand('jail', { target: this.otherPlayers[0].pog, minutes: 10, reason: 'x' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(
        'Could not teleport Prisoner. This game or connector may not support teleporting players. Prisoner was not jailed.',
      );
      expect(record(this)).to.equal(null);
    },
  }),

  createModuleTest({
    ...staff,
    name: 'cron teleports a jailed player back when outside the radius, not when inside',
    test: async function () {
      await this.runCommand('setjail');
      await this.runCommand('jail', { target: this.otherPlayers[0].pog, minutes: 10, reason: 'x' });
      const tp = this.client.stubs.gameserver.gameServerControllerTeleportPlayer;
      expect(tp).to.have.been.calledOnce;

      // The fake does not move the player on teleport: still at PRISONER_POS, far away.
      const out = await this.runCronJob('jail-enforcer');
      expect(out.success, JSON.stringify(out.logs)).to.be.true;
      expect(tp).to.have.been.calledTwice;
      expect(this.client.pmsTo(this.otherPlayers[0].pog.gameId).at(-1)).to.equal(
        'You cannot leave the jail. Time left: 10m.',
      );

      // Now inside the default 15 radius.
      const pog = this.otherPlayers[0].pog;
      pog.positionX = 110;
      pog.positionZ = 95;
      const inside = await this.runCronJob('jail-enforcer');
      expect(inside.success, JSON.stringify(inside.logs)).to.be.true;
      expect(tp).to.have.been.calledTwice;
    },
  }),

  createModuleTest({
    ...staff,
    name: 'cron releases an online player whose time is up, back to where they were',
    userConfig: { jailedRoleId: JAILED_ROLE },
    setup: function () {
      // The fake does not cover removeRole yet; record calls with a plain stub.
      const removed: unknown[][] = [];
      (this.client.stubs.player as Record<string, unknown>).playerControllerRemoveRole = async (...args: unknown[]) => {
        removed.push(args);
        return { data: { meta: {} } };
      };
      (this as unknown as { removed: unknown[][] }).removed = removed;
    },
    test: async function () {
      await this.runCommand('setjail');
      await this.runCommand('jail', { target: this.otherPlayers[0].pog, minutes: 10, reason: 'x' });
      const rec = record(this)!;
      this.variables.update(rec.row.id, { value: JSON.stringify({ ...rec.value, until: '2024-06-01T11:59:00.000Z' }) });

      const result = await this.runCronJob('jail-enforcer');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;

      const tp = this.client.stubs.gameserver.gameServerControllerTeleportPlayer;
      expect(tp?.lastCall.args[2]).to.deep.equal(PRISONER_POS);
      expect((this as unknown as { removed: unknown[][] }).removed).to.deep.equal([
        [this.otherPlayers[0].pog.playerId, JAILED_ROLE, { gameServerId: this.gameServerId }],
      ]);
      expect(record(this)).to.equal(null);
      expect(this.client.pmsTo(this.otherPlayers[0].pog.gameId).at(-1)).to.equal('You are free. Your jail time is over.');
    },
  }),

  createModuleTest({
    ...staff,
    name: 'release of an offline player waits until they connect',
    test: async function () {
      await this.runCommand('setjail');
      await this.runCommand('jail', { target: this.otherPlayers[0].pog, minutes: 0, reason: 'x' });
      expect(record(this)!.value.until).to.equal(null);

      this.otherPlayers[0].pog.online = false;
      const un = await this.runCommand('unjail', { target: this.otherPlayers[0].pog });
      expect(un.success, JSON.stringify(un.logs)).to.be.true;
      expect(this.pms().at(-1)).to.equal('Prisoner has been released. They will be moved out of jail when they are online.');
      expect(record(this)!.value.status).to.equal('pendingRelease');

      // Offline: cron leaves it alone.
      await this.runCronJob('jail-enforcer');
      expect(record(this)!.value.status).to.equal('pendingRelease');

      this.otherPlayers[0].pog.online = true;
      const cron = await this.runCronJob('jail-enforcer');
      expect(cron.success, JSON.stringify(cron.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerTeleportPlayer?.lastCall.args[2]).to.deep.equal(PRISONER_POS);
      expect(record(this)).to.equal(null);
    },
  }),

  createModuleTest({
    ...staff,
    name: 'releaseTo=releasePoint uses the saved release point',
    userConfig: { releaseTo: 'releasePoint' },
    test: async function () {
      await this.runCommand('setjail');
      this.pog.positionX = 7;
      this.pog.positionZ = 8;
      // `data.pog` is a snapshot per run, so the new position is used by the next command.
      await this.runCommand('setjail', { point: 'release' });
      await this.runCommand('jail', { target: this.otherPlayers[0].pog, minutes: 10, reason: 'x' });
      await this.runCommand('unjail', { target: this.otherPlayers[0].pog });
      expect(this.client.stubs.gameserver.gameServerControllerTeleportPlayer?.lastCall.args[2]).to.deep.equal({
        x: 7,
        y: 50,
        z: 8,
        dimension: 'overworld',
      });
      expect(this.pms().at(-1)).to.equal('Prisoner has been released.');
    },
  }),

  createModuleTest({
    ...staff,
    name: 'unjail on a free player says so',
    test: async function () {
      const result = await this.runCommand('unjail', { target: this.otherPlayers[0].pog });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('Prisoner is not in jail.');
    },
  }),

  createModuleTest({
    module: MODULE,
    now: FROZEN,
    name: 'connect hook puts a still-jailed player back in jail',
    player: { name: 'Prisoner', position: PRISONER_POS },
    setup: function () {
      this.variables.create({
        key: 'jail_location',
        value: JSON.stringify(STAFF_POS),
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
      });
      this.variables.create({
        key: 'jail_record',
        value: JSON.stringify({
          status: 'jailed',
          name: 'Prisoner',
          reason: 'spam',
          by: 'Staff',
          startedAt: FROZEN.toISOString(),
          until: '2024-06-01T12:05:00.000Z',
          returnTo: PRISONER_POS,
          roleId: null,
        }),
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
        playerId: this.pog.playerId,
      });
    },
    test: async function () {
      const result = await this.runHook('on-connect');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerTeleportPlayer?.firstCall.args[2]).to.deep.equal(STAFF_POS);
      expect(this.pms()).to.deep.equal(['You are still in jail (5m). Reason: spam. Type /jailtime for details.']);
    },
  }),
];

describe('Jail (module-VM)', function () {
  tests.forEach((test) => test.run());
});
