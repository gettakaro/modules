import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, type ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const group = 'Random teleport suite (module-VM)';

// The VM gets its own Date, so every case pins the clock.
const NOW = new Date('2026-06-01T12:00:00.000Z');
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000).toISOString();

const USE = [{ permission: 'RTP_USE' }];
const ME = { name: 'Alice', position: { x: 1, y: 50, z: 1, dimension: 'overworld' } };
// A ring of exactly radius 100 around 0,0: the first random value picks the radius, the second the angle.
const RING = { minRadius: 100, maxRadius: 100, cooldown: 0 };

type Row = { key: string; value: string; playerId?: string | null; expiresAt?: string };
const cooldownRows = (t: ModuleTest) => (t.variables.all as Row[]).filter((r) => r.key === 'rtp_cooldown');
const teleportStub = (t: ModuleTest) => t.client.stubs.gameserver.gameServerControllerTeleportPlayer;

function seedCooldown(t: ModuleTest, expiresIn: number) {
  t.variables.insert({
    key: 'rtp_cooldown',
    value: JSON.stringify({ usedAt: at(-10) }),
    expiresAt: at(expiresIn),
    playerId: t.pog.playerId,
    gameServerId: t.gameServerId,
    moduleId: t.moduleId,
  });
}

const tests = [
  createModuleTest({
    name: '/rtp teleports into the ring, keeps the dimension, uses the configured Y and starts the cooldown',
    module: MODULE,
    now: NOW,
    permissions: USE,
    player: ME,
    random: [0, 0.25],
    userConfig: { ...RING, centerX: 1000, centerZ: -500, y: 120, cooldown: 300_000 },
    test: async function () {
      const res = await this.runCommand('rtp');
      expect(res.success, JSON.stringify(res.logs)).to.be.true;

      const teleport = teleportStub(this);
      expect(teleport).to.have.been.calledOnce;
      expect(teleport?.firstCall.args[1]).to.equal(this.pog.playerId);
      // angle 0.25 * 2pi = 90 degrees: straight along +Z
      expect(teleport?.firstCall.args[2]).to.deep.equal({ x: 1000, y: 120, z: -400, dimension: 'overworld' });

      const rows = cooldownRows(this);
      expect(rows).to.have.length(1);
      expect(rows[0]!.playerId).to.equal(this.pog.playerId);
      expect(rows[0]!.expiresAt).to.equal(at(300));
      expect(this.pms()).to.deep.equal(['Teleported to a random spot at 1000, -400.']);
    },
  }),

  createModuleTest({
    name: 'the default Y is 0 and a zero cooldown stores nothing',
    module: MODULE,
    now: NOW,
    permissions: USE,
    player: { name: 'Alice', position: { x: 1, y: 50, z: 1 } },
    random: [0, 0],
    userConfig: RING,
    test: async function () {
      const res = await this.runCommand('rtp');
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(teleportStub(this)?.firstCall.args[2]).to.include({ x: 100, y: 0, z: 0 });
      expect(cooldownRows(this)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'rectangle areas pick inside the bounds',
    module: MODULE,
    now: NOW,
    permissions: USE,
    random: [0.5, 0.25],
    userConfig: { areaShape: 'rectangle', minX: 0, maxX: 1000, minZ: -400, maxZ: 400, cooldown: 0 },
    test: async function () {
      const res = await this.runCommand('rtp');
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      const dest = teleportStub(this)?.firstCall.args[2];
      expect(dest).to.include({ x: 500, z: -200 });
    },
  }),

  createModuleTest({
    name: 'spots inside blocked zones are skipped',
    module: MODULE,
    now: NOW,
    permissions: USE,
    // attempt 1: radius pick 0, angle 0 -> (100, 0), inside the trader circle
    // attempt 2: radius pick 0, angle 0.5 -> (-100, 0), inside the rectangle
    // attempt 3: radius pick 0, angle 0.25 -> (0, 100), free
    random: [0, 0, 0, 0.5, 0, 0.25],
    userConfig: {
      ...RING,
      blockedZones: [
        { name: 'Trader', shape: 'circle', x: 100, z: 0, radius: 10 },
        { name: 'Spawn', shape: 'rectangle', minX: -150, maxX: -50, minZ: -10, maxZ: 10 },
        { name: 'Broken', shape: 'circle', x: 0 },
      ],
    },
    test: async function () {
      const res = await this.runCommand('rtp');
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(teleportStub(this)).to.have.been.calledOnce;
      expect(teleportStub(this)?.firstCall.args[2]).to.include({ x: 0, z: 100 });
    },
  }),

  createModuleTest({
    name: 'gives up after maxAttempts when every spot is blocked, without charging',
    module: MODULE,
    now: NOW,
    permissions: USE,
    currency: 100,
    random: 0,
    userConfig: {
      ...RING,
      cost: 10,
      maxAttempts: 3,
      blockedZones: [{ shape: 'circle', x: 0, z: 0, radius: 5000 }],
    },
    test: async function () {
      const res = await this.runCommand('rtp');
      expect(this.userError(res)).to.equal('Could not find a free spot this time. Please try again. You were not charged.');
      expect(teleportStub(this)).to.not.have.been.called;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(100);
    },
  }),

  createModuleTest({
    name: '/rtp needs RTP_USE',
    module: MODULE,
    now: NOW,
    permissions: [],
    test: async function () {
      const res = await this.runCommand('rtp');
      expect(res.success).to.be.false;
      expect(this.userError(res)).to.equal('You do not have permission to use random teleport.');
      expect(teleportStub(this)).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'the cooldown blocks /rtp',
    module: MODULE,
    now: NOW,
    permissions: USE,
    userConfig: RING,
    setup: function () {
      seedCooldown(this, 90);
    },
    test: async function () {
      const res = await this.runCommand('rtp');
      expect(this.userError(res)).to.equal('You can random teleport again in 1m 30s.');
      expect(teleportStub(this)).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'an expired cooldown is renewed after the next teleport',
    module: MODULE,
    now: NOW,
    permissions: USE,
    userConfig: { ...RING, cooldown: 60_000 },
    setup: function () {
      seedCooldown(this, -1);
    },
    test: async function () {
      const res = await this.runCommand('rtp');
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      const rows = cooldownRows(this);
      expect(rows).to.have.length(1);
      expect(rows[0]!.expiresAt).to.equal(at(60));
    },
  }),

  createModuleTest({
    name: 'RTP_BYPASS_COOLDOWN ignores the cooldown and does not start a new one',
    module: MODULE,
    now: NOW,
    permissions: [{ permission: 'RTP_USE' }, { permission: 'RTP_BYPASS_COOLDOWN' }],
    userConfig: { ...RING, cooldown: 60_000 },
    setup: function () {
      seedCooldown(this, 30);
    },
    test: async function () {
      const res = await this.runCommand('rtp');
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(teleportStub(this)).to.have.been.calledOnce;
      expect(cooldownRows(this)[0]!.expiresAt).to.equal(at(30));
    },
  }),

  createModuleTest({
    name: 'the cost is charged after the teleport, named with the currency',
    module: MODULE,
    now: NOW,
    permissions: USE,
    currency: 50,
    random: 0,
    settings: { currencyName: 'Dukes' },
    userConfig: { ...RING, cost: 20 },
    test: async function () {
      const res = await this.runCommand('rtp');
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(30);
      expect(this.pms()).to.deep.equal(['Teleported to a random spot at 100, 0 (-20 Dukes).']);
    },
  }),

  createModuleTest({
    name: 'a player who cannot pay is refused before teleporting',
    module: MODULE,
    now: NOW,
    permissions: USE,
    currency: 5,
    settings: { currencyName: 'Dukes' },
    userConfig: { ...RING, cost: 20 },
    test: async function () {
      const res = await this.runCommand('rtp');
      expect(this.userError(res)).to.equal('A random teleport costs 20 Dukes and you have 5.');
      expect(teleportStub(this)).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'a failed teleport (game without teleport support) charges nothing and starts no cooldown',
    module: MODULE,
    now: NOW,
    permissions: USE,
    currency: 50,
    userConfig: { ...RING, cost: 20, cooldown: 60_000 },
    setup: function () {
      this.client.stubs.gameserver.gameServerControllerTeleportPlayer?.callsFake(async () => {
        throw new Error('Request failed with status code 400');
      });
    },
    test: async function () {
      const res = await this.runCommand('rtp');
      expect(this.userError(res)).to.equal(
        'Random teleport failed. This server may not support teleporting players. You were not charged.',
      );
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(50);
      expect(cooldownRows(this)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'a misconfigured ring tells the player to ask an admin',
    module: MODULE,
    now: NOW,
    permissions: USE,
    userConfig: { minRadius: 500, maxRadius: 100 },
    test: async function () {
      const res = await this.runCommand('rtp');
      expect(this.userError(res)).to.equal(
        'Random teleport is not set up correctly (minimum radius is above maximum radius). Please tell an admin.',
      );
      expect(teleportStub(this)).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'a misconfigured rectangle tells the player to ask an admin',
    module: MODULE,
    now: NOW,
    permissions: USE,
    userConfig: { areaShape: 'rectangle', minX: 100, maxX: 0 },
    test: async function () {
      const res = await this.runCommand('rtp');
      expect(this.userError(res)).to.equal(
        'Random teleport is not set up correctly (min is above max). Please tell an admin.',
      );
    },
  }),

  createModuleTest({
    name: 'with the default config every spot lands in the 500-2000 ring',
    module: MODULE,
    now: NOW,
    permissions: USE,
    random: [0.999, 0.1],
    test: async function () {
      const res = await this.runCommand('rtp');
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      const { x, z } = teleportStub(this)?.firstCall.args[2] as { x: number; z: number };
      const r = Math.sqrt(x * x + z * z);
      expect(r).to.be.within(1990, 2001);
      expect(cooldownRows(this)[0]!.expiresAt).to.equal(at(600));
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
