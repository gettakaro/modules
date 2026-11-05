import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import sinon from 'sinon';
import { createModuleTest, single, paginated } from '@takaro/module-test';
import type { ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const group = 'new-player-check (module-VM)';

const HOOK = 'check-on-join';
const CRON = 'recheck-pending';
// The fixture POG is created at 2024-01-01T00:00:00Z; five minutes later is a first join.
const FIRST_JOIN = new Date('2024-01-01T00:05:00.000Z');
const LATER = new Date('2024-01-03T00:00:00.000Z');

const ADMIN_GAME_ID = 'admin-game-id';
const ADMIN = { name: 'Admin', gameId: ADMIN_GAME_ID, permissions: [{ permission: 'NEW_PLAYER_CHECK_ALERTS' }] };

type InventoryItem = { itemId: string; code?: string; name?: string; quantity: number };

/**
 * The fake client covers no `tracking` or `role` controller, so module code calling them would
 * fail with UnstubbedMethodError. Wrap the fake's client to add those two controllers as sinon
 * stubs (or only the older inventory-history method, like older Takaro runners); every other
 * controller stays the fake's own.
 */
function addControllers(
  test: ModuleTest,
  opts: { inventory?: InventoryItem[] | null; roles?: { id: string; name: string }[]; legacyHistory?: unknown[] },
) {
  const tracking: Record<string, sinon.SinonStub> = opts.legacyHistory
    ? { trackingControllerGetPlayerInventoryHistory: sinon.stub().resolves(paginated(opts.legacyHistory)) }
    : {
        trackingControllerGetInventoryAt: sinon
          .stub()
          .callsFake(async (input: { at: string }) =>
            single(
              opts.inventory === null || opts.inventory === undefined
                ? { at: input.at, changesApplied: 0, items: [], truncated: false }
                : { at: input.at, snapshotTime: input.at, changesApplied: 0, items: opts.inventory, truncated: false },
            ),
          ),
      };
  const role = {
    roleControllerSearch: sinon
      .stub()
      .callsFake(async (query: { filters?: { name?: string[] } }) =>
        paginated((opts.roles ?? []).filter((r) => !query.filters?.name || query.filters.name.includes(r.name))),
      ),
  };
  const base = test.client.asClient;
  test.client.asClient = new Proxy(base, {
    get(target, property) {
      if (property === 'tracking') return tracking;
      if (property === 'role') return role;
      return Reflect.get(target, property);
    },
  });
  return { tracking, role };
}

function adminPms(test: ModuleTest): string[] {
  return test.client.pmsTo(ADMIN_GAME_ID);
}

const ITEM_CHEAT = 'aaaaaaaa-0000-4000-8000-000000000001';
const ITEM_WOOD = 'aaaaaaaa-0000-4000-8000-000000000002';

const tests = [
  createModuleTest({
    name: 'First join with a forbidden item alerts admins only (default action)',
    module: MODULE,
    now: FIRST_JOIN,
    permissions: [],
    player: { name: 'Newbie' },
    otherPlayers: [ADMIN],
    userConfig: { forbiddenItems: [{ item: ITEM_CHEAT }], discordChannelId: '123' },
    setup: function () {
      addControllers(this, { inventory: [{ itemId: ITEM_CHEAT, code: 'cheatGun', name: 'Cheat Gun', quantity: 1 }] });
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(adminPms(this)).to.deep.equal([
        '[New player check] Newbie: 1 item stacks - FLAGGED: forbidden item Cheat Gun x1. Action: alert only.',
      ]);
      expect(this.pms()).to.deep.equal([]);
      expect(this.client.stubs.discord.discordControllerSendMessage).to.have.been.calledOnceWith('123');
      expect(this.client.stubs.gameserver.gameServerControllerKickPlayer).to.not.have.been.called;
      expect(this.client.stubs.player.banControllerCreate).to.not.have.been.called;
      const status = JSON.parse(this.variables.all.find((v) => v.key === 'npcheck:status')!.value);
      expect(status.status).to.equal('flagged');
    },
  }),

  createModuleTest({
    name: 'Item codes from a template match as well as item IDs, and maxAmount allows up to that many',
    module: MODULE,
    now: FIRST_JOIN,
    permissions: [],
    player: { name: 'Hoarder' },
    otherPlayers: [ADMIN],
    userConfig: {
      forbiddenItems: [
        { item: 'material_wood', maxAmount: 500 },
        { item: ITEM_CHEAT, maxAmount: 5 },
      ],
    },
    setup: function () {
      addControllers(this, {
        inventory: [
          { itemId: ITEM_WOOD, code: 'Material_Wood', name: 'Wood', quantity: 400 },
          { itemId: ITEM_WOOD, code: 'Material_Wood', name: 'Wood', quantity: 400 },
          { itemId: ITEM_CHEAT, code: 'cheatGun', name: 'Cheat Gun', quantity: 5 },
        ],
      });
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(adminPms(this)).to.have.length(1);
      expect(adminPms(this)[0]).to.contain('FLAGGED: Wood x800 (max 500)');
      expect(adminPms(this)[0]).to.not.contain('Cheat Gun');
    },
  }),

  createModuleTest({
    name: 'Older Takaro without inventory-at: the newest history row per item is used',
    module: MODULE,
    now: FIRST_JOIN,
    permissions: [],
    player: { name: 'Oldie' },
    otherPlayers: [ADMIN],
    userConfig: { forbiddenItems: [{ item: ITEM_CHEAT }, { item: ITEM_WOOD }] },
    setup: function () {
      addControllers(this, {
        legacyHistory: [
          {
            itemId: ITEM_CHEAT,
            itemCode: 'cheatGun',
            itemName: 'Cheat Gun',
            quantity: 3,
            createdAt: '2024-01-01T00:01:00.000Z',
          },
          {
            itemId: ITEM_CHEAT,
            itemCode: 'cheatGun',
            itemName: 'Cheat Gun',
            quantity: 2,
            createdAt: '2024-01-01T00:04:00.000Z',
          },
          { itemId: ITEM_WOOD, itemCode: 'wood', itemName: 'Wood', quantity: 5, createdAt: '2024-01-01T00:01:00.000Z' },
          { itemId: ITEM_WOOD, itemCode: 'wood', itemName: 'Wood', quantity: 0, createdAt: '2024-01-01T00:03:00.000Z' },
        ],
      });
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(adminPms(this)).to.deep.equal([
        '[New player check] Oldie: 1 item stacks - FLAGGED: forbidden item Cheat Gun x2. Action: alert only.',
      ]);
    },
  }),

  createModuleTest({
    name: 'Level above the limit kicks when levelAction is kick (level from progression)',
    module: MODULE,
    now: FIRST_JOIN,
    permissions: [],
    player: { name: 'Veteran' },
    otherPlayers: [ADMIN],
    userConfig: { maxLevelOnFirstJoin: 20, levelAction: 'kick', actionReason: 'No transfers' },
    setup: function () {
      addControllers(this, {});
      (this.pog as unknown as Record<string, unknown>).progression = {
        source: 'server',
        observedAt: FIRST_JOIN.toISOString(),
        tracks: [
          { key: 'character', level: 45 },
          { key: 'mining', level: 3 },
        ],
      };
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerKickPlayer).to.have.been.calledOnceWith(
        this.gameServerId,
        this.player.id,
        { reason: 'No transfers' },
      );
      expect(adminPms(this)).to.deep.equal([
        '[New player check] Veteran: level 45 - FLAGGED: level 45 (limit 20). Action: kicked.',
      ]);
    },
  }),

  createModuleTest({
    name: 'Level from a configured console command (game without progression); ban and role together',
    module: MODULE,
    now: FIRST_JOIN,
    permissions: [],
    player: { name: 'Transfer' },
    otherPlayers: [ADMIN],
    userConfig: {
      maxLevelOnFirstJoin: 10,
      levelCommand: 'level {gameId}',
      levelPattern: ': level (\\d+)',
      levelAction: 'ban',
      maxTotalItems: 2,
      totalItemsAction: 'role',
      banDuration: 0,
    },
    setup: function () {
      addControllers(this, {
        inventory: [{ itemId: ITEM_WOOD, code: 'wood', name: 'Wood', quantity: 3 }],
        roles: [{ id: 'role-flagged', name: 'Flagged' }],
      });
      this.client.stubs.gameserver.gameServerControllerExecuteCommand?.callsFake(async () =>
        single({ rawResult: 'Transfer (abc): level 30', success: true }),
      );
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerExecuteCommand).to.have.been.calledOnceWith(
        this.gameServerId,
        { command: `level ${this.pog.gameId}` },
      );
      expect(this.client.stubs.player.playerControllerAssignRole).to.have.been.calledOnceWith(
        this.player.id,
        'role-flagged',
        { gameServerId: this.gameServerId },
      );
      const ban = this.client.stubs.player.banControllerCreate!.firstCall.args[0] as unknown as Record<string, unknown>;
      expect(ban.playerId).to.equal(this.player.id);
      expect(ban).to.not.have.property('until');
      expect(adminPms(this)[0]).to.contain('Action: role Flagged, banned permanently.');
    },
  }),

  createModuleTest({
    name: 'Game reports no level and no inventory rules: nothing happens, clean status',
    module: MODULE,
    now: FIRST_JOIN,
    permissions: [],
    otherPlayers: [ADMIN],
    userConfig: { maxLevelOnFirstJoin: 20 },
    setup: function () {
      addControllers(this, {});
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.deep.equal([]);
      expect(this.client.stubs.gameserver.gameServerControllerExecuteCommand).to.not.have.been.called;
      const status = JSON.parse(this.variables.all.find((v) => v.key === 'npcheck:status')!.value);
      expect(status.status).to.equal('clean');
    },
  }),

  createModuleTest({
    name: 'Returning player outside the watch window is not checked',
    module: MODULE,
    now: LATER,
    permissions: [],
    otherPlayers: [ADMIN],
    userConfig: { forbiddenItems: [{ item: ITEM_CHEAT }], watchHours: 24 },
    setup: function () {
      addControllers(this, { inventory: [{ itemId: ITEM_CHEAT, name: 'Cheat Gun', quantity: 1 }] });
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.deep.equal([]);
      expect(this.variables.all).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Inside the watch window a rejoin is checked, but the same findings do not alert twice',
    module: MODULE,
    now: LATER,
    permissions: [],
    player: { name: 'Newbie' },
    otherPlayers: [ADMIN],
    userConfig: { forbiddenItems: [{ item: ITEM_CHEAT }], watchHours: 72 },
    setup: function () {
      addControllers(this, { inventory: [{ itemId: ITEM_CHEAT, name: 'Cheat Gun', quantity: 1 }] });
    },
    test: async function () {
      await this.runHook(HOOK);
      const second = await this.runHook(HOOK);
      expect(second.success, JSON.stringify(second.logs)).to.be.true;
      expect(adminPms(this)).to.have.length(1);
    },
  }),

  createModuleTest({
    name: 'A player an admin marked reviewed is not checked again',
    module: MODULE,
    now: FIRST_JOIN,
    permissions: [],
    otherPlayers: [ADMIN],
    userConfig: { forbiddenItems: [{ item: ITEM_CHEAT }] },
    setup: function () {
      addControllers(this, { inventory: [{ itemId: ITEM_CHEAT, name: 'Cheat Gun', quantity: 1 }] });
      this.variables.create(
        {
          key: 'npcheck:status',
          value: JSON.stringify({ status: 'reviewed' }),
          gameServerId: this.gameServerId,
          playerId: this.player.id,
          moduleId: this.moduleId,
        },
        FIRST_JOIN,
      );
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Exempt players are skipped',
    module: MODULE,
    now: FIRST_JOIN,
    permissions: [{ permission: 'NEW_PLAYER_CHECK_EXEMPT' }],
    otherPlayers: [ADMIN],
    userConfig: { forbiddenItems: [{ item: ITEM_CHEAT }] },
    setup: function () {
      addControllers(this, { inventory: [{ itemId: ITEM_CHEAT, name: 'Cheat Gun', quantity: 1 }] });
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'Unknown inventory at join is retried by the cron job once Takaro has a snapshot',
    module: MODULE,
    now: FIRST_JOIN,
    permissions: [],
    player: { name: 'Fresh' },
    otherPlayers: [ADMIN],
    userConfig: { forbiddenItems: [{ item: ITEM_CHEAT }] },
    test: async function () {
      const opts: { inventory: InventoryItem[] | null } = { inventory: null };
      addControllers(this, opts);
      const join = await this.runHook(HOOK);
      expect(join.success, JSON.stringify(join.logs)).to.be.true;
      expect(this.variables.all.map((v) => v.key)).to.include('npcheck:pending');
      expect(adminPms(this)).to.deep.equal([]);

      opts.inventory = [{ itemId: ITEM_CHEAT, name: 'Cheat Gun', quantity: 2 }];
      const cron = await this.runCronJob(CRON);
      expect(cron.success, JSON.stringify(cron.logs)).to.be.true;
      expect(adminPms(this)).to.deep.equal([
        '[New player check] Fresh: 1 item stacks - FLAGGED: forbidden item Cheat Gun x2. Action: alert only.',
      ]);
      expect(this.variables.all.map((v) => v.key)).to.not.include('npcheck:pending');
    },
  }),

  createModuleTest({
    name: 'npcheck reports to the admin without acting',
    module: MODULE,
    permissions: [{ permission: 'NEW_PLAYER_CHECK_MANAGE' }],
    otherPlayers: [{ name: 'Suspect', permissions: [] }],
    userConfig: { forbiddenItems: [{ item: ITEM_CHEAT }], itemAction: 'ban' },
    setup: function () {
      addControllers(this, { inventory: [{ itemId: ITEM_CHEAT, name: 'Cheat Gun', quantity: 1 }] });
    },
    test: async function () {
      const result = await this.runCommand('npcheck', { player: this.otherPlayers[0].pog });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        '[New player check] Suspect: 1 item stacks - FLAGGED: forbidden item Cheat Gun x1',
      ]);
      expect(this.client.stubs.player.banControllerCreate).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'npcheck without the manage permission is refused',
    module: MODULE,
    permissions: [],
    otherPlayers: [{ name: 'Suspect' }],
    test: async function () {
      const result = await this.runCommand('npcheck', { player: this.otherPlayers[0].pog });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.match(/permission/);
    },
  }),

  createModuleTest({
    name: 'npclear marks the player reviewed and removes the flag role',
    module: MODULE,
    now: FIRST_JOIN,
    permissions: [{ permission: 'NEW_PLAYER_CHECK_MANAGE' }],
    otherPlayers: [{ name: 'Suspect' }],
    userConfig: { forbiddenItems: [{ item: ITEM_CHEAT }] },
    setup: function () {
      addControllers(this, {
        inventory: [{ itemId: ITEM_CHEAT, name: 'Cheat Gun', quantity: 1 }],
        roles: [{ id: 'role-flagged', name: 'Flagged' }],
      });
      const suspect = this.otherPlayers[0].pog as unknown as { roles: unknown[]; playerId: string };
      suspect.roles.push({
        roleId: 'role-flagged',
        playerId: suspect.playerId,
        role: { name: 'Flagged', permissions: [] },
      });
      (this.client.stubs.player as Record<string, unknown>).playerControllerRemoveRole = sinon
        .stub()
        .resolves(single({}));
    },
    test: async function () {
      const suspect = this.otherPlayers[0].pog;
      const result = await this.runCommand('npclear', { player: suspect });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        '[New player check] Suspect is marked as reviewed and will not be checked again. Role Flagged removed.',
      ]);
      const removeRole = (this.client.stubs.player as Record<string, sinon.SinonStub>).playerControllerRemoveRole;
      expect(removeRole).to.have.been.calledOnceWith(suspect.playerId, 'role-flagged');
      const row = this.variables.all.find((v) => v.key === 'npcheck:status' && v.playerId === suspect.playerId)!;
      expect(JSON.parse(row.value).status).to.equal('reviewed');
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
