import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, type ModuleTest, type PlayerSpec } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const JAIL = new URL('../../../jail/', import.meta.url);
const BANK = new URL('../../../bank/', import.meta.url);
const ECONOMY_ON = { economyEnabled: 'true' };
const NOW = new Date('2026-11-26T12:00:00.000Z');
const MIN = 60000;

const victim = (extra: Partial<PlayerSpec> = {}): PlayerSpec => ({
  name: 'Victim',
  currency: 1000,
  permissions: [],
  online: true,
  ...extra,
});

function stateOf(t: ModuleTest, playerId: string) {
  const rows = t.variables.all.filter((r) => r.key === 'crime_state' && r.playerId === playerId && r.moduleId === t.moduleId);
  expect(rows.length).to.be.at.most(1);
  return rows[0] ? JSON.parse(rows[0].value) : null;
}

function seedState(t: ModuleTest, playerId: string, state: Record<string, unknown>) {
  t.variables.insert({
    key: 'crime_state',
    value: JSON.stringify(state),
    gameServerId: t.gameServerId,
    moduleId: t.moduleId,
    playerId,
  });
}

async function jailModuleId(t: ModuleTest) {
  const res = await t.client.stubs.module.moduleInstallationsControllerGetInstalledModules!({});
  const inst = res.data.data.find((i: { module: { name: string } }) => i.module.name === 'jail');
  if (!inst) throw new Error('jail not installed in test');
  return inst.moduleId;
}

const tests = [
  // ---------------- crime ----------------
  createModuleTest({
    name: 'crime win pays the reward and starts the cooldown',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 500,
    now: NOW,
    random: [0.9, 0.5, 0],
    test: async function () {
      const result = await this.runCommand('crime');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'You picked a pocket at the market and got away with 125 test coin.',
        'Next crime in 30m.',
      ]);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(625);
      const s = stateOf(this, this.pog.playerId);
      expect(s.crimes).to.equal(1);
      expect(s.crimesWon).to.equal(1);
      expect(s.crimeEarned).to.equal(125);
      expect(s.crimeReadyAt).to.equal(new Date(NOW.getTime() + 30 * MIN).toISOString());
    },
  }),

  createModuleTest({
    name: 'crime fail takes the fine',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 500,
    now: NOW,
    random: [0.1, 0, 0],
    test: async function () {
      const result = await this.runCommand('crime');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()[0]).to.equal('The guards caught you shoplifting. You paid a fine of 25 test coin.');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(475);
      expect(stateOf(this, this.pog.playerId).crimeFines).to.equal(25);
    },
  }),

  createModuleTest({
    name: 'crime uses custom texts and amounts',
    module: MODULE,
    settings: { ...ECONOMY_ON, currencyName: 'caps' },
    currency: 500,
    now: NOW,
    random: [0.99, 0.99, 0],
    userConfig: { crimeRewardMin: 10, crimeRewardMax: 10, crimeWinTexts: ['{player} looted {amount}'], crimeCooldownMinutes: 0 },
    player: { name: 'Ann' },
    test: async function () {
      const result = await this.runCommand('crime');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Ann looted 10 caps']);
    },
  }),

  createModuleTest({
    name: 'crime during the cooldown is refused and changes nothing',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 500,
    now: NOW,
    setup: function () {
      seedState(this, this.pog.playerId, { crimeReadyAt: new Date(NOW.getTime() + 61 * MIN).toISOString(), crimes: 3 });
    },
    test: async function () {
      const result = await this.runCommand('crime');
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('Lie low for a while. You can do a crime again in 1h 1m.');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(500);
      expect(stateOf(this, this.pog.playerId).crimes).to.equal(3);
    },
  }),

  createModuleTest({
    name: 'crime needs the max fine in the wallet',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 99,
    test: async function () {
      const result = await this.runCommand('crime');
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(
        'You need at least 100 test coin in your wallet to cover a possible fine. You have 99 test coin.',
      );
      expect(this.variables.all).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'crime is refused when the economy is off',
    module: MODULE,
    settings: { economyEnabled: 'false' },
    currency: 500,
    test: async function () {
      const result = await this.runCommand('crime');
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('The economy is turned off on this server, so crime does not pay here.');
    },
  }),

  // ---------------- rob ----------------
  createModuleTest({
    name: 'rob success moves a share of the wallet and protects the victim',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 300,
    now: NOW,
    random: [0.9, 0.5],
    player: { name: 'Robber' },
    otherPlayers: [victim()],
    test: async function () {
      const v = this.otherPlayers[0];
      const result = await this.runCommand('rob', { target: v.pog });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      // 12.5% of 1000
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(425);
      expect(this.currency.balanceOf(v.pog.playerId)).to.equal(875);
      expect(this.pms()).to.deep.equal(['You robbed Victim and got away with 125 test coin.']);
      expect(this.client.pmsTo(v.pog.gameId)).to.deep.equal(['Robber robbed you and took 125 test coin from your wallet.']);
      expect(this.messages.map((m) => m.message)).to.include('Robber robbed Victim for 125 test coin.');
      const r = stateOf(this, this.pog.playerId);
      expect(r.robsWon).to.equal(1);
      expect(r.stolen).to.equal(125);
      expect(r.robReadyAt).to.equal(new Date(NOW.getTime() + 60 * MIN).toISOString());
      const vs = stateOf(this, v.pog.playerId);
      expect(vs.timesRobbed).to.equal(1);
      expect(vs.lostToRobbers).to.equal(125);
      expect(vs.protectedUntil).to.equal(new Date(NOW.getTime() + 120 * MIN).toISOString());
    },
  }),

  createModuleTest({
    name: 'rob fail pays the victim a fine (50% of the max loot)',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 300,
    now: NOW,
    random: [0.1],
    player: { name: 'Robber' },
    otherPlayers: [victim()],
    test: async function () {
      const v = this.otherPlayers[0];
      const result = await this.runCommand('rob', { target: v.pog });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      // max loot 20% of 1000 = 200, fine 50% = 100
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(200);
      expect(this.currency.balanceOf(v.pog.playerId)).to.equal(1100);
      expect(this.pms()).to.deep.equal(['Victim caught you. You paid Victim a fine of 100 test coin.']);
      expect(this.client.pmsTo(v.pog.gameId)).to.deep.equal([
        'Robber tried to rob you and got caught. You get 100 test coin as compensation.',
      ]);
      expect(this.messages.map((m) => m.message)).to.include('Robber got caught trying to rob Victim.');
      expect(stateOf(this, v.pog.playerId).protectedUntil).to.equal(null);
      expect(stateOf(this, this.pog.playerId).robFines).to.equal(100);
    },
  }),

  createModuleTest({
    name: 'rob without announce sends no broadcast',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 300,
    random: [0.9, 0.5],
    userConfig: { announce: false },
    otherPlayers: [victim()],
    test: async function () {
      const v = this.otherPlayers[0];
      await this.runCommand('rob', { target: v.pog });
      expect(this.messages.filter((m) => !m.recipientGameId)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'rob loot is capped by robMaxAmount',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 1000,
    random: [0.9, 1 - 1e-9],
    otherPlayers: [victim({ currency: 100000 })],
    test: async function () {
      const v = this.otherPlayers[0];
      const result = await this.runCommand('rob', { target: v.pog });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(v.pog.playerId)).to.equal(99000);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(2000);
    },
  }),

  createModuleTest({
    name: 'rob refuses yourself',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 1000,
    test: async function () {
      const result = await this.runCommand('rob', { target: this.pog });
      expect(this.userError(result)).to.equal('You cannot rob yourself.');
    },
  }),

  createModuleTest({
    name: 'rob refuses an offline victim',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 1000,
    otherPlayers: [victim({ online: false })],
    test: async function () {
      const v = this.otherPlayers[0];
      const result = await this.runCommand('rob', { target: v.pog });
      expect(this.userError(result)).to.equal('Victim is not online. You can only rob players who are online.');
      expect(this.currency.balanceOf(v.pog.playerId)).to.equal(1000);
      expect(this.variables.all).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'rob refuses a victim with ROB_IMMUNE',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 1000,
    otherPlayers: [victim({ name: 'Admin', permissions: [{ permission: 'ROB_IMMUNE' }] })],
    test: async function () {
      const v = this.otherPlayers[0];
      const result = await this.runCommand('rob', { target: v.pog });
      expect(this.userError(result)).to.equal('Admin is protected and cannot be robbed.');
      expect(this.currency.balanceOf(v.pog.playerId)).to.equal(1000);
    },
  }),

  createModuleTest({
    name: 'rob refuses a victim inside the protection window',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 1000,
    now: NOW,
    otherPlayers: [victim()],
    setup: function () {
      seedState(this, this.otherPlayers[0].pog.playerId, { protectedUntil: new Date(NOW.getTime() + 45 * MIN).toISOString() });
    },
    test: async function () {
      const result = await this.runCommand('rob', { target: this.otherPlayers[0].pog });
      expect(this.userError(result)).to.equal('Victim was robbed recently. Try again in 45m.');
      expect(stateOf(this, this.pog.playerId)).to.equal(null);
    },
  }),

  createModuleTest({
    name: 'rob refuses during the robber cooldown',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 1000,
    now: NOW,
    otherPlayers: [victim()],
    setup: function () {
      seedState(this, this.pog.playerId, { robReadyAt: new Date(NOW.getTime() + 10 * MIN).toISOString() });
    },
    test: async function () {
      const result = await this.runCommand('rob', { target: this.otherPlayers[0].pog });
      expect(this.userError(result)).to.equal('You are still laying low. You can rob again in 10m.');
    },
  }),

  createModuleTest({
    name: 'rob refuses a victim below the minimum wallet',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 1000,
    otherPlayers: [victim({ currency: 199 })],
    test: async function () {
      const result = await this.runCommand('rob', { target: this.otherPlayers[0].pog });
      expect(this.userError(result)).to.equal('Victim has too little in their wallet to be worth robbing.');
    },
  }),

  createModuleTest({
    name: 'rob needs the fine in the robber wallet',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 99,
    otherPlayers: [victim()],
    test: async function () {
      const result = await this.runCommand('rob', { target: this.otherPlayers[0].pog });
      expect(this.userError(result)).to.equal(
        'You need at least 100 test coin in your wallet to pay the fine if you get caught. You have 99 test coin.',
      );
      expect(this.variables.all).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'rob never touches bank savings (bank module variables)',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 300,
    random: [0.9, 0.5],
    alsoInstalled: [{ module: BANK }],
    otherPlayers: [victim()],
    setup: function () {
      this.variables.insert({
        key: 'bank_account',
        value: JSON.stringify({ balance: 50000 }),
        gameServerId: this.gameServerId,
        moduleId: '7c1d2a9e-1b5f-4c3e-9e0a-2f6b8d4c1a01',
        playerId: this.otherPlayers[0].pog.playerId,
      });
    },
    test: async function () {
      const v = this.otherPlayers[0];
      const result = await this.runCommand('rob', { target: v.pog });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(v.pog.playerId)).to.equal(875);
      const bank = this.variables.all.find((r) => r.key === 'bank_account');
      expect(JSON.parse(bank!.value).balance).to.equal(50000);
    },
  }),

  // ---------------- jail integration ----------------
  createModuleTest({
    name: 'failed rob sends the robber to jail when the jail module is installed',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 300,
    now: NOW,
    random: [0.1],
    userConfig: { robJailMinutes: 5 },
    alsoInstalled: [{ module: JAIL }],
    player: { name: 'Robber', position: { x: 10, y: 20, z: 30 } },
    otherPlayers: [victim()],
    setup: async function () {
      this.variables.insert({
        key: 'jail_location',
        value: JSON.stringify({ x: 100, y: 50, z: -100, dimension: null }),
        gameServerId: this.gameServerId,
        moduleId: await jailModuleId(this),
      });
    },
    test: async function () {
      const result = await this.runCommand('rob', { target: this.otherPlayers[0].pog });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      // The jail module's cron does the teleport; this module never teleports.
      expect(this.client.stubs.gameserver.gameServerControllerTeleportPlayer).to.not.have.been.called;
      const jailId = await jailModuleId(this);
      const row = this.variables.all.find((r) => r.key === 'jail_record' && r.moduleId === jailId);
      const rec = JSON.parse(row!.value);
      expect(row!.playerId).to.equal(this.pog.playerId);
      expect(rec.status).to.equal('jailed');
      expect(rec.until).to.equal(new Date(NOW.getTime() + 5 * MIN).toISOString());
      expect(rec.returnTo).to.deep.include({ x: 10, y: 20, z: 30 });
      expect(rec.reason).to.equal('Caught robbing Victim');
      expect(this.pms()).to.include('The guards take you to jail for 5m.');
    },
  }),

  createModuleTest({
    name: 'jailed player cannot do crimes',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 500,
    now: NOW,
    userConfig: { crimeJailMinutes: 5 },
    alsoInstalled: [{ module: JAIL }],
    setup: async function () {
      this.variables.insert({
        key: 'jail_record',
        value: JSON.stringify({ status: 'jailed', until: new Date(NOW.getTime() + 3 * MIN).toISOString() }),
        gameServerId: this.gameServerId,
        moduleId: await jailModuleId(this),
        playerId: this.pog.playerId,
      });
    },
    test: async function () {
      const result = await this.runCommand('crime');
      expect(this.userError(result)).to.equal('You are in jail. No crimes until you are released.');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(500);
    },
  }),

  createModuleTest({
    name: 'jail on fail is skipped when the jail module is not installed',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 500,
    random: [0.1, 0, 0],
    userConfig: { crimeJailMinutes: 5 },
    test: async function () {
      const result = await this.runCommand('crime');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerTeleportPlayer).to.not.have.been.called;
      expect(this.pms().some((m) => m.includes('jail'))).to.be.false;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(475);
    },
  }),

  createModuleTest({
    name: 'jail on fail is skipped when no jail spot is set',
    module: MODULE,
    settings: ECONOMY_ON,
    currency: 500,
    random: [0.1, 0, 0],
    userConfig: { crimeJailMinutes: 5 },
    alsoInstalled: [{ module: JAIL }],
    test: async function () {
      const result = await this.runCommand('crime');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.variables.all.filter((r) => r.key === 'jail_record')).to.have.length(0);
      expect(this.pms().some((m) => m.includes('jail'))).to.be.false;
    },
  }),

  // ---------------- crimestats ----------------
  createModuleTest({
    name: 'crimestats shows the record and cooldowns',
    module: MODULE,
    settings: ECONOMY_ON,
    now: NOW,
    setup: function () {
      seedState(this, this.pog.playerId, {
        crimes: 5,
        crimesWon: 3,
        crimeEarned: 1200,
        crimeFines: 75,
        robs: 2,
        robsWon: 1,
        stolen: 90,
        robFines: 100,
        timesRobbed: 1,
        lostToRobbers: 40,
        finesReceived: 0,
        robReadyAt: new Date(NOW.getTime() + 12 * MIN).toISOString(),
        protectedUntil: new Date(NOW.getTime() + 90 * MIN).toISOString(),
      });
    },
    test: async function () {
      const result = await this.runCommand('crimestats');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Crime: 5 tries, 3 got away. Earned 1,200, fines 75 test coin.',
        'Robbery: 2 tries, 1 got away. Stolen 90, fines 100 test coin.',
        'Times robbed: 1, lost 40. Fines received 0 test coin.',
        'Crime ready | Rob in 12m | Protected from robbers for 1h 30m.',
      ]);
    },
  }),
];

describe('rob-and-crime', () => {
  for (const t of tests) t.run();
});
