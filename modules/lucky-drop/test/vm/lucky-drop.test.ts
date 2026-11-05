import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, type ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const group = 'lucky-drop suite (module-VM)';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const MIN = 60_000;
const ECONOMY_ON = { economyEnabled: 'true' };
const ELIGIBLE = { permission: 'LUCKY_DROP_ELIGIBLE' };
const ADMIN = { permission: 'LUCKY_DROP_ADMIN' };

// One tier only, so the tier roll never matters unless a test says so.
const ONE_TIER = [{ rarity: 'Rare', weight: 1, currency: 200, items: [] }];

function insert(t: ModuleTest, key: string, value: unknown, playerId?: string) {
  t.variables.insert({
    key,
    value: JSON.stringify(value),
    gameServerId: t.gameServerId,
    moduleId: t.moduleId,
    ...(playerId ? { playerId } : {}),
  });
}

function read(t: ModuleTest, key: string, playerId?: string) {
  const row = t.variables.all.find(
    (r) => r.key === key && r.moduleId === t.moduleId && (playerId ? r.playerId === playerId : !r.playerId),
  );
  return row ? JSON.parse(row.value) : undefined;
}

function dueNow(t: ModuleTest) {
  insert(t, 'lucky_drop_next_at', new Date(NOW.getTime() - MIN).toISOString());
}

function sessionStarted(t: ModuleTest, playerId: string, minutesAgo: number) {
  insert(t, 'lucky_drop_session', new Date(NOW.getTime() - minutesAgo * MIN).toISOString(), playerId);
}

function broadcasts(t: ModuleTest) {
  return t.messages.filter((m) => m.recipientGameId === undefined).map((m) => m.message);
}

const tests = [
  createModuleTest({
    name: 'First tick only schedules the next drop',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    userConfig: { dropIntervalMinutes: 30, jitterMinutes: 10 },
    // Math.random 1 -> +10 min jitter.
    random: 0.9999999,
    test: async function () {
      const result = await this.runCronJob('dropTick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.have.length(0);
      const next = new Date(read(this, 'lucky_drop_next_at')).getTime();
      expect(Math.round((next - NOW.getTime()) / MIN)).to.equal(40);
      // Online player without a session record gets one now.
      expect(read(this, 'lucky_drop_session', this.player.id)).to.equal(NOW.toISOString());
    },
  }),

  createModuleTest({
    name: 'Due drop gives the reward to an eligible player and announces it',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    permissions: [ELIGIBLE],
    currency: 0,
    player: { name: 'Limon' },
    userConfig: { minOnlinePlayers: 1, minSessionMinutes: 0, excludeAfk: false, jitterMinutes: 0, dropIntervalMinutes: 45 },
    setup: function () {
      dueNow(this);
    },
    test: async function () {
      // Default table 70/25/5: roll 0.8 * 100 = 80 -> Rare (200).
      const result = await this.runCronJob('dropTick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.player.id)).to.equal(200);
      expect(broadcasts(this)).to.deep.equal(['🎁 Limon got a Rare lucky drop: 200 test coin!']);
      const history = read(this, 'lucky_drop_history');
      expect(history.total).to.equal(1);
      expect(history.byRarity).to.deep.equal({ Rare: 1 });
      expect(history.recent[0]).to.include({ player: 'Limon', rarity: 'Rare', reward: '200 test coin', mode: 'random' });
      const next = new Date(read(this, 'lucky_drop_next_at')).getTime();
      expect(next - NOW.getTime()).to.equal(45 * MIN);
    },
    random: 0.8,
  }),

  createModuleTest({
    name: 'Not due yet: nothing happens',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    permissions: [ELIGIBLE],
    setup: function () {
      insert(this, 'lucky_drop_next_at', new Date(NOW.getTime() + 10 * MIN).toISOString());
    },
    test: async function () {
      const result = await this.runCronJob('dropTick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'Too few players online: waits and keeps the due time',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    permissions: [ELIGIBLE],
    userConfig: { minOnlinePlayers: 2 },
    setup: function () {
      dueNow(this);
    },
    test: async function () {
      const before = read(this, 'lucky_drop_next_at');
      const result = await this.runCronJob('dropTick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.have.length(0);
      expect(read(this, 'lucky_drop_next_at')).to.equal(before);
      expect(read(this, 'lucky_drop_history')).to.be.undefined;
    },
  }),

  createModuleTest({
    name: 'Skips players without permission, short sessions and AFK players',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    permissions: [ELIGIBLE],
    player: { name: 'Afk', position: { x: 10, y: 0, z: 10 } },
    otherPlayers: [
      { name: 'NoPerm', permissions: [] },
      { name: 'Newbie', permissions: [ELIGIBLE] },
      { name: 'Active', permissions: [ELIGIBLE], position: { x: 50, y: 0, z: 50 } },
    ],
    userConfig: { rewards: ONE_TIER, minOnlinePlayers: 1, minSessionMinutes: 10, excludeAfk: true },
    setup: function () {
      dueNow(this);
      const [noPerm, newbie, active] = this.otherPlayers;
      sessionStarted(this, this.player.id, 60);
      sessionStarted(this, noPerm.player.id, 60);
      sessionStarted(this, newbie.player.id, 2);
      sessionStarted(this, active.player.id, 60);
      insert(this, 'lucky_drop_positions', {
        [this.player.id]: { x: 10, y: 0, z: 10 },
        [active.player.id]: { x: 0, y: 0, z: 0 },
      });
    },
    // Several rolls: every value the same, so any candidate list of one is deterministic.
    random: 0.5,
    test: async function () {
      const result = await this.runCronJob('dropTick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(broadcasts(this)).to.deep.equal(['🎁 Active got a Rare lucky drop: 200 test coin!']);
      expect(this.currency.balanceOf(this.otherPlayers[2].player.id)).to.equal(200);
      // New positions are stored for the next tick.
      expect(read(this, 'lucky_drop_positions')[this.otherPlayers[2].player.id]).to.deep.equal({ x: 50, y: 0, z: 50 });
    },
  }),

  createModuleTest({
    name: 'Nobody eligible: no reward, timer moves on',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    permissions: [],
    userConfig: { rewards: ONE_TIER, minOnlinePlayers: 1, minSessionMinutes: 0, jitterMinutes: 0 },
    setup: function () {
      dueNow(this);
    },
    test: async function () {
      const result = await this.runCronJob('dropTick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.have.length(0);
      expect(this.currency.balanceOf(this.player.id)).to.equal(0);
      expect(new Date(read(this, 'lucky_drop_next_at')).getTime()).to.be.greaterThan(NOW.getTime());
    },
  }),

  ...[0.26, 0.74].map((roll) =>
    createModuleTest({
      name: `VIP weight count makes the VIP win (roll ${roll})`,
      module: MODULE,
      now: NOW,
      settings: ECONOMY_ON,
      permissions: [ELIGIBLE, { permission: 'LUCKY_DROP_VIP_WEIGHT', count: 3 }],
      player: { name: 'Vip' },
      otherPlayers: [{ name: 'Normal', permissions: [ELIGIBLE] }],
      userConfig: { rewards: ONE_TIER, minOnlinePlayers: 1, minSessionMinutes: 0, excludeAfk: false },
      setup: function () {
        dueNow(this);
      },
      // Weights 3 and 1: any roll in [0.25, 0.75) picks the VIP whatever the order; with equal
      // weights these two rolls would pick different players.
      random: roll,
      test: async function () {
        const result = await this.runCronJob('dropTick');
        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(broadcasts(this)).to.deep.equal(['🎁 Vip got a Rare lucky drop: 200 test coin!']);
      },
    }),
  ),

  createModuleTest({
    name: 'Economy off and currency-only table: no drop, clear log',
    module: MODULE,
    now: NOW,
    settings: { economyEnabled: 'false' },
    permissions: [ELIGIBLE],
    userConfig: { minOnlinePlayers: 1, minSessionMinutes: 0 },
    setup: function () {
      dueNow(this);
    },
    test: async function () {
      const result = await this.runCronJob('dropTick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.have.length(0);
      expect(JSON.stringify(result.logs)).to.contain('no usable reward');
    },
  }),

  createModuleTest({
    name: 'Item rewards are given with the item name in the announcement',
    module: MODULE,
    now: NOW,
    settings: { economyEnabled: 'false' },
    permissions: [ELIGIBLE],
    player: { name: 'Limon' },
    userConfig: {
      rewards: [
        { rarity: 'Legendary', weight: 1, currency: 500, items: [{ item: 'item-1', amount: 2, quality: '6' }] },
      ],
      minOnlinePlayers: 1,
      minSessionMinutes: 0,
    },
    setup: function () {
      dueNow(this);
      this.client.stubs.item.itemControllerFindOne?.resolves({
        data: { data: { id: 'item-1', name: 'Auger', code: 'meleeToolAuger' } },
      } as never);
    },
    test: async function () {
      const result = await this.runCronJob('dropTick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerGiveItem).to.have.been.calledOnceWith(
        this.gameServerId,
        this.player.id,
        { name: 'item-1', amount: 2, quality: '6' },
      );
      // Economy off: the currency part is dropped, items still go out.
      expect(broadcasts(this)).to.deep.equal(['🎁 Limon got a Legendary lucky drop: 2x Auger!']);
      expect(this.currency.balanceOf(this.player.id)).to.equal(0);
    },
  }),

  createModuleTest({
    name: 'Failed item delivery: winner gets a PM, history marks it',
    module: MODULE,
    now: NOW,
    settings: { economyEnabled: 'false' },
    permissions: [ELIGIBLE],
    userConfig: {
      rewards: [{ rarity: 'Rare', weight: 1, items: [{ item: 'item-1', amount: 1 }] }],
      minOnlinePlayers: 1,
      minSessionMinutes: 0,
    },
    setup: function () {
      dueNow(this);
      this.client.stubs.item.itemControllerFindOne?.rejects(new Error('nope'));
      this.client.stubs.gameserver.gameServerControllerGiveItem?.rejects(new Error('not supported'));
    },
    test: async function () {
      const result = await this.runCronJob('dropTick');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Part of your lucky drop could not be delivered. Please contact an admin.']);
      expect(read(this, 'lucky_drop_history').recent[0].failed).to.be.true;
    },
  }),

  createModuleTest({
    name: 'Claim race: tick announces, first grab wins, second grab is refused',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    permissions: [ELIGIBLE],
    currency: 0,
    player: { name: 'Fast' },
    userConfig: { rewards: ONE_TIER, mode: 'claimRace', claimWindowSeconds: 30, minOnlinePlayers: 1 },
    setup: function () {
      dueNow(this);
    },
    test: async function () {
      const tick = await this.runCronJob('dropTick');
      expect(tick.success, JSON.stringify(tick.logs)).to.be.true;
      expect(broadcasts(this)).to.deep.equal(['🎁 A Rare lucky drop appeared! Type /grab within 30 s to claim it!']);
      expect(this.currency.balanceOf(this.player.id)).to.equal(0);

      const grab = await this.runCommand('grab');
      expect(grab.success, JSON.stringify(grab.logs)).to.be.true;
      expect(this.currency.balanceOf(this.player.id)).to.equal(200);
      expect(broadcasts(this)[1]).to.equal('🎁 Fast got a Rare lucky drop: 200 test coin!');
      expect(read(this, 'lucky_drop_race')).to.be.undefined;
      expect(read(this, 'lucky_drop_history').recent[0].mode).to.equal('claimRace');

      const again = await this.runCommand('grab');
      expect(again.success).to.be.false;
      expect(this.userError(again)).to.equal('There is no lucky drop to grab right now.');
      expect(this.currency.balanceOf(this.player.id)).to.equal(200);
    },
  }),

  createModuleTest({
    name: 'Claim race: a running race blocks new drops',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    permissions: [ELIGIBLE],
    userConfig: { rewards: ONE_TIER, mode: 'claimRace', minOnlinePlayers: 1 },
    setup: function () {
      dueNow(this);
      insert(this, 'lucky_drop_race', {
        id: 'r1',
        tier: { rarity: 'Rare', weight: 1, currency: 200, items: [] },
        reward: '200 test coin',
        expiresAt: new Date(NOW.getTime() + 20_000).toISOString(),
      });
    },
    test: async function () {
      const tick = await this.runCronJob('dropTick');
      expect(tick.success, JSON.stringify(tick.logs)).to.be.true;
      expect(this.messages).to.have.length(0);
      expect(read(this, 'lucky_drop_race').id).to.equal('r1');
    },
  }),

  createModuleTest({
    name: 'Claim race: someone else holds the claim lock',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    permissions: [ELIGIBLE],
    currency: 0,
    setup: function () {
      insert(this, 'lucky_drop_race', {
        id: 'r2',
        tier: { rarity: 'Rare', weight: 1, currency: 200, items: [] },
        reward: '200 test coin',
        expiresAt: new Date(NOW.getTime() + 20_000).toISOString(),
      });
      insert(this, 'lucky_drop_claim_r2', 'someone-else');
    },
    test: async function () {
      const grab = await this.runCommand('grab');
      expect(grab.success).to.be.false;
      expect(this.userError(grab)).to.equal('Someone was faster! The lucky drop is already taken.');
      expect(this.currency.balanceOf(this.player.id)).to.equal(0);
    },
  }),

  createModuleTest({
    name: 'Claim race: grab without permission is refused',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    permissions: [],
    setup: function () {
      insert(this, 'lucky_drop_race', {
        id: 'r3',
        tier: { rarity: 'Rare', weight: 1, currency: 200, items: [] },
        reward: '200 test coin',
        expiresAt: new Date(NOW.getTime() + 20_000).toISOString(),
      });
    },
    test: async function () {
      const grab = await this.runCommand('grab');
      expect(grab.success).to.be.false;
      expect(this.userError(grab)).to.equal('You are not allowed to grab lucky drops.');
    },
  }),

  createModuleTest({
    name: 'Claim race: grab after the window is too late; next tick announces expiry',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    permissions: [ELIGIBLE],
    userConfig: { mode: 'claimRace' },
    setup: function () {
      insert(this, 'lucky_drop_next_at', new Date(NOW.getTime() + 30 * MIN).toISOString());
      insert(this, 'lucky_drop_race', {
        id: 'r4',
        tier: { rarity: 'Legendary', weight: 1, currency: 1000, items: [] },
        reward: '1000 test coin',
        expiresAt: new Date(NOW.getTime() - 1000).toISOString(),
      });
    },
    test: async function () {
      const grab = await this.runCommand('grab');
      expect(this.userError(grab)).to.equal('Too late, this lucky drop has expired.');

      const tick = await this.runCronJob('dropTick');
      expect(tick.success, JSON.stringify(tick.logs)).to.be.true;
      expect(broadcasts(this)).to.deep.equal([
        'Nobody grabbed the Legendary lucky drop in time. Better luck next time!',
      ]);
      expect(read(this, 'lucky_drop_race')).to.be.undefined;
    },
  }),

  createModuleTest({
    name: 'Hook stores the session start of a connecting player',
    module: MODULE,
    now: NOW,
    setup: function () {
      sessionStarted(this, this.player.id, 500);
    },
    test: async function () {
      const result = await this.runHook('on-player-connected');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(read(this, 'lucky_drop_session', this.player.id)).to.equal(NOW.toISOString());
      expect(this.variables.all.filter((r) => r.key === 'lucky_drop_session')).to.have.length(1);
    },
  }),

  createModuleTest({
    name: 'luckystats needs the admin permission',
    module: MODULE,
    permissions: [ELIGIBLE],
    test: async function () {
      const result = await this.runCommand('luckystats');
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You do not have permission to view lucky drop stats.');
    },
  }),

  createModuleTest({
    name: 'luckystats shows totals, next drop and recent drops',
    module: MODULE,
    now: NOW,
    permissions: [ADMIN],
    setup: function () {
      insert(this, 'lucky_drop_next_at', new Date(NOW.getTime() + 12 * MIN).toISOString());
      insert(this, 'lucky_drop_history', {
        total: 3,
        byRarity: { Common: 2, Legendary: 1 },
        recent: [
          { at: new Date(NOW.getTime() - 5 * MIN).toISOString(), player: 'Limon', rarity: 'Legendary', reward: '1000 test coin' },
          { at: new Date(NOW.getTime() - 3 * 60 * MIN).toISOString(), player: 'Bob', rarity: 'Common', reward: '50 test coin', failed: true },
        ],
      });
    },
    test: async function () {
      const result = await this.runCommand('luckystats');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Lucky drops (random): 3 total | Common 2, Legendary 1',
        'Next drop in about 12 min',
        '5m ago: Limon - Legendary: 1000 test coin',
        '3h ago: Bob - Common: 50 test coin (delivery failed)',
      ]);
    },
  }),

  createModuleTest({
    name: 'luckystats with no data',
    module: MODULE,
    now: NOW,
    permissions: [ADMIN],
    test: async function () {
      const result = await this.runCommand('luckystats');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Lucky drops (random): 0 total',
        'Next drop: not scheduled yet (the timer starts at the next check)',
        'No drops yet.',
      ]);
    },
  }),

  createModuleTest({
    name: 'luckydropnow forces a drop, ignoring min players and session time',
    module: MODULE,
    now: NOW,
    settings: ECONOMY_ON,
    permissions: [ADMIN, ELIGIBLE],
    player: { name: 'Limon' },
    currency: 0,
    userConfig: { rewards: ONE_TIER, minOnlinePlayers: 5, minSessionMinutes: 60, jitterMinutes: 0, dropIntervalMinutes: 30 },
    test: async function () {
      const result = await this.runCommand('luckydropnow');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.player.id)).to.equal(200);
      expect(broadcasts(this)).to.deep.equal(['🎁 Limon got a Rare lucky drop: 200 test coin!']);
      expect(this.pms()).to.deep.equal(['Lucky drop: Limon won Rare: 200 test coin. Next drop in about 30 min.']);
    },
  }),

  createModuleTest({
    name: 'luckydropnow needs the admin permission',
    module: MODULE,
    permissions: [ELIGIBLE],
    test: async function () {
      const result = await this.runCommand('luckydropnow');
      expect(this.userError(result)).to.equal('You do not have permission to force a lucky drop.');
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
