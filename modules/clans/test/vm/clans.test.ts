import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, type ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'clans suite (module-VM)';

type Role = 'leader' | 'officer' | 'member';
type Member = { id: string; name: string; role: Role };
type Ctx = ModuleTest;

/** Seeds a clan record plus one membership row per member, as the module itself writes them. */
function seedClan(ctx: Ctx, clan: { name: string; tag: string; members: Member[]; bank?: number; invites?: unknown[] }) {
  ctx.variables.insert({
    key: `clan:${clan.name.toLowerCase()}`,
    value: JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z', bank: 0, invites: [], ...clan }),
    gameServerId: ctx.gameServerId,
    moduleId: ctx.moduleId,
  });
  for (const member of clan.members) {
    ctx.variables.insert({
      key: 'clan_membership',
      value: JSON.stringify({ clan: clan.name.toLowerCase() }),
      gameServerId: ctx.gameServerId,
      moduleId: ctx.moduleId,
      playerId: member.id,
    });
  }
}

function readClan(ctx: Ctx, name: string) {
  const row = ctx.variables.all.find((r) => r.key === `clan:${name.toLowerCase()}`);
  return row ? JSON.parse(row.value) : null;
}

function memberships(ctx: Ctx) {
  return ctx.variables.all.filter((r) => r.key === 'clan_membership').map((r) => r.playerId);
}

const ALICE = { name: 'Alice' };

const tests = [
  createModuleTest({
    name: 'create: makes a clan with the creator as leader',
    module: MODULE,
    player: ALICE,
    test: async function () {
      const result = await this.runCommand('clan', { action: 'create', arg1: 'Wolves', arg2: 'WLF' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;

      const clan = readClan(this, 'Wolves');
      expect(clan.name).to.equal('Wolves');
      expect(clan.tag).to.equal('WLF');
      expect(clan.members).to.have.length(1);
      expect(clan.members[0]).to.include({ id: this.player.id, name: 'Alice', role: 'leader' });
      expect(memberships(this)).to.deep.equal([this.player.id]);
      expect(this.pms()[0]).to.equal('Clan [WLF] Wolves created. Invite players with /clan invite <player>.');
    },
  }),

  createModuleTest({
    name: 'create: charges the configured cost',
    module: MODULE,
    player: ALICE,
    currency: 500,
    userConfig: { createCost: 200 },
    test: async function () {
      const result = await this.runCommand('clan', { action: 'create', arg1: 'Wolves', arg2: 'WLF' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(300);
      expect(this.pms()[0]).to.contain('for 200 test coin');
    },
  }),

  createModuleTest({
    name: 'create: refuses when the player cannot pay',
    module: MODULE,
    currency: 50,
    userConfig: { createCost: 200 },
    test: async function () {
      const result = await this.runCommand('clan', { action: 'create', arg1: 'Wolves', arg2: 'WLF' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('Creating a clan costs 200 test coin. You have 50.');
      expect(this.variables.all).to.have.length(0);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(50);
    },
  }),

  createModuleTest({
    name: 'create: enforces name/tag rules and uniqueness',
    module: MODULE,
    userConfig: { blockedWords: ['admin'] },
    otherPlayers: [{ name: 'Bob' }],
    setup: function () {
      seedClan(this, { name: 'Wolves', tag: 'WLF', members: [{ id: this.otherPlayers[0].player.id, name: 'Bob', role: 'leader' }] });
    },
    test: async function () {
      const cases: Array<[string, string, RegExp]> = [
        ['Ab', 'XY', /name must be 3-16/],
        ['Bears', 'TOOLONG', /tag must be 2-4/],
        ['Bad-Name', 'BN', /letters, numbers and _/],
        ['TheAdmins', 'ADM', /not allowed/],
        ['wolves', 'NEW', /already exists/],
        ['Bears', 'wlf', /already taken/],
        ['', '', /Usage: clan create/],
      ];
      for (const [name, tag, error] of cases) {
        const result = await this.runCommand('clan', { action: 'create', arg1: name, arg2: tag });
        expect(result.success, `${name}/${tag}`).to.be.false;
        expect(this.userError(result)).to.match(error);
      }
      expect(this.variables.all.filter((r) => String(r.key).startsWith('clan:'))).to.have.length(1);
    },
  }),

  createModuleTest({
    name: 'create: refuses when already in a clan',
    module: MODULE,
    setup: function () {
      seedClan(this, { name: 'Wolves', tag: 'WLF', members: [{ id: this.player.id, name: 'Alice', role: 'leader' }] });
    },
    test: async function () {
      const result = await this.runCommand('clan', { action: 'create', arg1: 'Bears', arg2: 'BRS' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.match(/already in a clan/);
    },
  }),

  createModuleTest({
    name: 'invite: leader invites an online player who gets a PM',
    module: MODULE,
    player: ALICE,
    otherPlayers: [{ name: 'Bob Builder' }, { name: 'Carol' }],
    setup: function () {
      seedClan(this, { name: 'Wolves', tag: 'WLF', members: [{ id: this.player.id, name: 'Alice', role: 'leader' }] });
    },
    test: async function () {
      const result = await this.runCommand(
        'clan',
        { action: 'invite', arg1: 'bob', arg2: 'builder' },
        { chatMessage: '/clan invite bob builder' },
      );
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const bob = this.otherPlayers[0];
      const clan = readClan(this, 'Wolves');
      expect(clan.invites).to.have.length(1);
      expect(clan.invites[0]).to.include({ id: bob.player.id, name: 'Bob Builder', by: 'Alice' });
      expect(this.client.pmsTo(bob.pog.gameId)).to.deep.equal([
        'Alice invited you to clan [WLF] Wolves. Type /clan join Wolves within 60 minutes.',
      ]);
      expect(this.pms()).to.deep.equal(['Invite sent to Bob Builder.']);
    },
  }),

  createModuleTest({
    name: 'invite: regular members cannot invite',
    module: MODULE,
    userConfig: { maxMembers: 2 },
    otherPlayers: [{ name: 'Bob' }, { name: 'Carol' }],
    setup: function () {
      seedClan(this, {
        name: 'Wolves',
        tag: 'WLF',
        members: [
          { id: this.otherPlayers[0].player.id, name: 'Bob', role: 'leader' },
          { id: this.player.id, name: 'Alice', role: 'member' },
        ],
      });
    },
    test: async function () {
      const result = await this.runCommand('clan', { action: 'invite', arg1: 'Carol' });
      expect(this.userError(result)).to.equal('Only the clan leader or officers can invite players.');
    },
  }),

  createModuleTest({
    name: 'join: needs an open invite, then joins and tells online members',
    module: MODULE,
    player: ALICE,
    otherPlayers: [{ name: 'Bob' }],
    now: new Date('2026-06-01T12:00:00.000Z'),
    setup: function () {
      seedClan(this, {
        name: 'Wolves',
        tag: 'WLF',
        members: [{ id: this.otherPlayers[0].player.id, name: 'Bob', role: 'leader' }],
        invites: [{ id: this.player.id, name: 'Alice', by: 'Bob', expiresAt: '2026-06-01T12:30:00.000Z' }],
      });
      seedClan(this, {
        name: 'Bears',
        tag: 'BRS',
        members: [{ id: 'f3a1c5e2-0000-4000-8000-000000000001', name: 'Dave', role: 'leader' }],
      });
    },
    test: async function () {
      const noInvite = await this.runCommand('clan', { action: 'join', arg1: 'Bears' });
      expect(this.userError(noInvite)).to.equal('You have no open invite from [BRS] Bears.');

      const result = await this.runCommand('clan', { action: 'join', arg1: 'wolves' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const clan = readClan(this, 'Wolves');
      expect(clan.members.map((m: Member) => m.name)).to.deep.equal(['Bob', 'Alice']);
      expect(clan.invites).to.have.length(0);
      expect(this.client.pmsTo(this.otherPlayers[0].pog.gameId)).to.deep.equal(['[WLF] Alice joined the clan.']);
      expect(this.pms()).to.deep.equal(['You joined [WLF] Wolves.']);
    },
  }),

  createModuleTest({
    name: 'join: expired invite is refused',
    module: MODULE,
    otherPlayers: [{ name: 'Bob' }],
    now: new Date('2026-06-01T12:00:00.000Z'),
    setup: function () {
      seedClan(this, {
        name: 'Wolves',
        tag: 'WLF',
        members: [{ id: this.otherPlayers[0].player.id, name: 'Bob', role: 'leader' }],
        invites: [{ id: this.player.id, name: 'Alice', by: 'Bob', expiresAt: '2026-06-01T11:00:00.000Z' }],
      });
    },
    test: async function () {
      const result = await this.runCommand('clan', { action: 'join', arg1: 'Wolves' });
      expect(this.userError(result)).to.match(/no open invite/);
    },
  }),

  createModuleTest({
    name: 'leave: leader leaving hands leadership to an officer',
    module: MODULE,
    player: ALICE,
    otherPlayers: [{ name: 'Bob' }, { name: 'Carol' }],
    setup: function () {
      seedClan(this, {
        name: 'Wolves',
        tag: 'WLF',
        members: [
          { id: this.player.id, name: 'Alice', role: 'leader' },
          { id: this.otherPlayers[0].player.id, name: 'Bob', role: 'member' },
          { id: this.otherPlayers[1].player.id, name: 'Carol', role: 'officer' },
        ],
      });
    },
    test: async function () {
      const result = await this.runCommand('clan', { action: 'leave' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const clan = readClan(this, 'Wolves');
      expect(clan.members.map((m: Member) => [m.name, m.role])).to.deep.equal([
        ['Bob', 'member'],
        ['Carol', 'leader'],
      ]);
      expect(memberships(this)).to.not.include(this.player.id);
      expect(this.client.pmsTo(this.otherPlayers[0].pog.gameId)).to.deep.equal([
        '[WLF] Alice left the clan. Carol is the new leader.',
      ]);
    },
  }),

  createModuleTest({
    name: 'leave: last member disbands the clan and gets the bank',
    module: MODULE,
    currency: 10,
    setup: function () {
      seedClan(this, { name: 'Wolves', tag: 'WLF', bank: 90, members: [{ id: this.player.id, name: 'Alice', role: 'leader' }] });
    },
    test: async function () {
      const result = await this.runCommand('clan', { action: 'leave' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.variables.all).to.have.length(0);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(100);
      expect(this.pms()).to.deep.equal([
        'You left and [WLF] Wolves was disbanded. The clan bank (90 test coin) was paid to you.',
      ]);
    },
  }),

  createModuleTest({
    name: 'kick: officers can kick members but not officers; leader can kick officers',
    module: MODULE,
    otherPlayers: [{ name: 'Bob' }, { name: 'Carol' }, { name: 'Dave' }],
    setup: function () {
      seedClan(this, {
        name: 'Wolves',
        tag: 'WLF',
        members: [
          { id: this.otherPlayers[0].player.id, name: 'Bob', role: 'leader' },
          { id: this.player.id, name: 'Alice', role: 'officer' },
          { id: this.otherPlayers[1].player.id, name: 'Carol', role: 'officer' },
          { id: this.otherPlayers[2].player.id, name: 'Dave', role: 'member' },
        ],
      });
    },
    test: async function () {
      const denied = await this.runCommand('clan', { action: 'kick', arg1: 'Carol' });
      expect(this.userError(denied)).to.equal('Officers can only kick regular members.');

      const result = await this.runCommand('clan', { action: 'kick', arg1: 'dav' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const clan = readClan(this, 'Wolves');
      expect(clan.members.map((m: Member) => m.name)).to.deep.equal(['Bob', 'Alice', 'Carol']);
      expect(memberships(this)).to.not.include(this.otherPlayers[2].player.id);

      const unknown = await this.runCommand('clan', { action: 'kick', arg1: 'Zed' });
      expect(this.userError(unknown)).to.equal('No member of your clan matches "Zed".');
    },
  }),

  createModuleTest({
    name: 'promote/demote: only the leader changes ranks',
    module: MODULE,
    otherPlayers: [{ name: 'Bob' }],
    setup: function () {
      seedClan(this, {
        name: 'Wolves',
        tag: 'WLF',
        members: [
          { id: this.player.id, name: 'Alice', role: 'leader' },
          { id: this.otherPlayers[0].player.id, name: 'Bob', role: 'member' },
        ],
      });
    },
    test: async function () {
      const up = await this.runCommand('clan', { action: 'promote', arg1: 'Bob' });
      expect(up.success, JSON.stringify(up.logs)).to.be.true;
      expect(readClan(this, 'Wolves').members[1].role).to.equal('officer');
      const down = await this.runCommand('clan', { action: 'demote', arg1: 'Bob' });
      expect(down.success, JSON.stringify(down.logs)).to.be.true;
      expect(readClan(this, 'Wolves').members[1].role).to.equal('member');
    },
  }),

  createModuleTest({
    name: 'chat: PMs every online member with the full message',
    module: MODULE,
    player: ALICE,
    otherPlayers: [{ name: 'Bob' }, { name: 'Carol', online: false }, { name: 'Eve' }],
    setup: function () {
      seedClan(this, {
        name: 'Wolves',
        tag: 'WLF',
        members: [
          { id: this.player.id, name: 'Alice', role: 'leader' },
          { id: this.otherPlayers[0].player.id, name: 'Bob', role: 'member' },
          { id: this.otherPlayers[1].player.id, name: 'Carol', role: 'member' },
        ],
      });
    },
    test: async function () {
      const result = await this.runCommand(
        'clan',
        { action: 'chat', arg1: 'meet', arg2: 'at' },
        { chatMessage: '/clan chat meet at the base now' },
      );
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const line = '[WLF] Alice: meet at the base now';
      expect(this.pms()).to.deep.equal([line]);
      expect(this.client.pmsTo(this.otherPlayers[0].pog.gameId)).to.deep.equal([line]);
      expect(this.client.pmsTo(this.otherPlayers[1].pog.gameId)).to.deep.equal([]);
      expect(this.client.pmsTo(this.otherPlayers[2].pog.gameId)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'bank: deposit takes currency, leader withdraws, bad amounts refused',
    module: MODULE,
    currency: 100,
    otherPlayers: [{ name: 'Bob' }],
    setup: function () {
      seedClan(this, {
        name: 'Wolves',
        tag: 'WLF',
        bank: 20,
        members: [
          { id: this.player.id, name: 'Alice', role: 'leader' },
          { id: this.otherPlayers[0].player.id, name: 'Bob', role: 'member' },
        ],
      });
    },
    test: async function () {
      const dep = await this.runCommand('clan', { action: 'bank', arg1: 'deposit', arg2: '60' });
      expect(dep.success, JSON.stringify(dep.logs)).to.be.true;
      expect(readClan(this, 'Wolves').bank).to.equal(80);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(40);

      const tooMuch = await this.runCommand('clan', { action: 'bank', arg1: 'withdraw', arg2: '500' });
      expect(this.userError(tooMuch)).to.equal('The bank only holds 80 test coin.');

      const bad = await this.runCommand('clan', { action: 'bank', arg1: 'deposit', arg2: 'abc' });
      expect(this.userError(bad)).to.equal('Amount must be a positive whole number.');

      const wd = await this.runCommand('clan', { action: 'bank', arg1: 'withdraw', arg2: '30' });
      expect(wd.success, JSON.stringify(wd.logs)).to.be.true;
      expect(readClan(this, 'Wolves').bank).to.equal(50);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(70);
    },
  }),

  createModuleTest({
    name: 'bank: disabled by config',
    module: MODULE,
    userConfig: { enableBank: false },
    setup: function () {
      seedClan(this, { name: 'Wolves', tag: 'WLF', members: [{ id: this.player.id, name: 'Alice', role: 'leader' }] });
    },
    test: async function () {
      const result = await this.runCommand('clan', { action: 'bank' });
      expect(this.userError(result)).to.equal('The clan bank is disabled on this server.');
    },
  }),

  createModuleTest({
    name: 'info, list and top show clans',
    module: MODULE,
    otherPlayers: [{ name: 'Bob' }, { name: 'Carol' }],
    setup: function () {
      seedClan(this, {
        name: 'Wolves',
        tag: 'WLF',
        bank: 5,
        members: [
          { id: this.player.id, name: 'Alice', role: 'leader' },
          { id: this.otherPlayers[0].player.id, name: 'Bob', role: 'officer' },
        ],
      });
      seedClan(this, { name: 'Bears', tag: 'BRS', members: [{ id: this.otherPlayers[1].player.id, name: 'Carol', role: 'leader' }] });
      this.otherPlayers[1].pog.playtimeSeconds = 36000;
      this.pog.playtimeSeconds = 3600;
    },
    test: async function () {
      const info = await this.runCommand('clan', { action: 'info' });
      expect(info.success, JSON.stringify(info.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        '[WLF] Wolves - 2/10 members',
        'Leader: Alice',
        'Officers: Bob',
        'Bank: 5 test coin',
      ]);

      const list = await this.runCommand('clan', { action: 'list' });
      expect(list.success, JSON.stringify(list.logs)).to.be.true;
      expect(this.pms().slice(4)).to.deep.equal(['Clans (2):', '[WLF] Wolves - 2 members', '[BRS] Bears - 1 member']);

      const top = await this.runCommand('clan', { action: 'top' });
      expect(top.success, JSON.stringify(top.logs)).to.be.true;
      expect(this.pms().slice(7)).to.deep.equal([
        'Top clans by total member playtime:',
        '1. [BRS] Bears - 10h (1 member)',
        '2. [WLF] Wolves - 1h (2 members)',
      ]);
    },
  }),

  createModuleTest({
    name: 'disband: admin can disband any clan, leaders only their own',
    module: MODULE,
    permissions: [{ permission: 'CLANS_USE' }, { permission: 'CLANS_ADMIN' }],
    otherPlayers: [{ name: 'Bob' }],
    setup: function () {
      seedClan(this, { name: 'Wolves', tag: 'WLF', members: [{ id: this.otherPlayers[0].player.id, name: 'Bob', role: 'leader' }] });
    },
    test: async function () {
      const result = await this.runCommand('clan', { action: 'disband', arg1: 'Wolves' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.variables.all).to.have.length(0);
      expect(this.client.pmsTo(this.otherPlayers[0].pog.gameId)).to.deep.equal([
        '[WLF] The clan was disbanded by an admin.',
      ]);
    },
  }),

  createModuleTest({
    name: 'permissions: no CLANS_USE is refused, no CLANS_CREATE cannot create',
    module: MODULE,
    permissions: [{ permission: 'CLANS_USE' }],
    test: async function () {
      const result = await this.runCommand('clan', { action: 'create', arg1: 'Wolves', arg2: 'WLF' });
      expect(this.userError(result)).to.equal('You do not have permission to create a clan.');
      const help = await this.runCommand('clan');
      expect(help.success, JSON.stringify(help.logs)).to.be.true;
      expect(this.pms()[0]).to.match(/^Clans: \/clan create/);
    },
  }),

  createModuleTest({
    name: 'permissions: without CLANS_USE nothing works',
    module: MODULE,
    permissions: [],
    test: async function () {
      const result = await this.runCommand('clan', { action: 'list' });
      expect(this.userError(result)).to.equal('You do not have permission to use clans.');
    },
  }),

  createModuleTest({
    name: 'stale membership rows are cleaned up',
    module: MODULE,
    setup: function () {
      this.variables.insert({
        key: 'clan_membership',
        value: JSON.stringify({ clan: 'ghosts' }),
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
        playerId: this.player.id,
      });
    },
    test: async function () {
      const result = await this.runCommand('clan', { action: 'create', arg1: 'Wolves', arg2: 'WLF' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(readClan(this, 'Wolves').members[0].id).to.equal(this.player.id);
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
