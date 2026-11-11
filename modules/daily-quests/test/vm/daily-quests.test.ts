import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const DAILY_REWARDS = new URL('../../../dailyRewards/', import.meta.url);
const STATE_KEY = 'dq_state';
// 10:00 UTC; with resetHourUtc 0 the quest day is 2026-11-05.
const NOW = new Date('2026-11-05T10:00:00.000Z');
const TODAY = '2026-11-05';

const quest = (id: string, type: string, target: number, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  target,
  description: '',
  filter: '',
  rewardCurrency: 0,
  rewardItems: [],
  weight: 1,
  enabled: true,
  ...extra,
});

const active = (def: ReturnType<typeof quest>, progress = 0, done = false) => ({
  id: def.id,
  type: def.type,
  description: def.description,
  target: def.target,
  filter: def.filter,
  rewardCurrency: def.rewardCurrency,
  rewardItems: def.rewardItems,
  progress,
  done,
  milestone: 0,
});

function stateOf(t: { variables: { all: Array<{ key: string; value: string; playerId?: string | null }> } }, playerId: string) {
  const row = t.variables.all.find((r) => r.key === STATE_KEY && r.playerId === playerId);
  return row ? JSON.parse(row.value) : null;
}

function seed(this: any, state: Record<string, unknown>, playerId?: string) {
  this.variables.insert({
    key: STATE_KEY,
    value: JSON.stringify({ day: TODAY, rerollsUsed: 0, bonusPaid: false, lastTick: null, ignoreCredits: [], ...state }),
    gameServerId: this.gameServerId,
    moduleId: this.moduleId,
    playerId: playerId ?? this.pog.playerId,
  });
}

const KILL = quest('kill-zombies', 'kill', 4, { filter: 'zombie', rewardCurrency: 100, description: 'Kill {target} zombies' });
const CHAT = quest('chat-3', 'chat', 3, { rewardCurrency: 10 });
const EARN = quest('earn-200', 'currency', 200, { rewardCurrency: 50 });
const PLAY = quest('play-30', 'playtime', 30, { rewardCurrency: 20 });
const SHOP = quest('shop-1', 'shop', 1, { filter: 'tape', rewardCurrency: 5 });
const DAILY = quest('claim-daily', 'command', 1, { filter: 'daily', rewardCurrency: 25 });
const DEATH = quest('die-1', 'death', 1, { rewardCurrency: 1 });

const tests = [
  createModuleTest({
    name: 'quests command hands out N quests, skips disabled types and uninstalled commands',
    module: MODULE,
    now: NOW,
    random: 0,
    userConfig: {
      questsPerDay: 2,
      enabledTypes: { chat: false },
      quests: [CHAT, DAILY, KILL, PLAY, EARN],
    },
    test: async function () {
      const result = await this.runCommand('quests');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const state = stateOf(this, this.pog.playerId);
      expect(state.day).to.equal(TODAY);
      // chat is disabled, `daily` isn't installed: random 0 picks the first eligible each time.
      expect(state.quests.map((q: { id: string }) => q.id)).to.deep.equal(['kill-zombies', 'play-30']);
      expect(state.lastTick).to.equal(NOW.toISOString());
      // One message per line: 7 Days to Die chat does not render line breaks.
      const pms = this.pms();
      expect(pms).to.have.length(4);
      expect(pms[0]).to.equal('Daily quests (0/2 done, reset in 14h 0m):');
      expect(pms[1]).to.contain('1. Kill 4 zombies - 0/4 (100 test coin)');
      expect(pms[2]).to.contain('2. Play 30 minutes - 0/30 (20 test coin)');
      expect(pms[3]).to.contain('/questreroll <number> (100 test coin, 1 left today)');
    },
  }),

  createModuleTest({
    name: 'quests command with an empty pool says so',
    module: MODULE,
    now: NOW,
    userConfig: { quests: [] },
    test: async function () {
      const result = await this.runCommand('quests');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()[0]).to.contain('No daily quests are available');
    },
  }),

  createModuleTest({
    name: 'extra quests permission count adds quests',
    module: MODULE,
    now: NOW,
    random: 0,
    permissions: [{ permission: 'DAILY_QUESTS_EXTRA_QUESTS', count: 2 }],
    userConfig: { questsPerDay: 1, quests: [KILL, PLAY, EARN, CHAT] },
    test: async function () {
      await this.runCommand('quests');
      expect(stateOf(this, this.pog.playerId).quests).to.have.length(3);
    },
  }),

  createModuleTest({
    name: 'stale day gets new quests',
    module: MODULE,
    now: NOW,
    random: 0,
    userConfig: { questsPerDay: 1, quests: [KILL] },
    setup: function () {
      seed.call(this, { day: '2026-11-04', quests: [active(KILL, 4, true)], rerollsUsed: 1 });
    },
    test: async function () {
      await this.runCommand('quests');
      const state = stateOf(this, this.pog.playerId);
      expect(state.day).to.equal(TODAY);
      expect(state.quests[0].progress).to.equal(0);
      expect(state.quests[0].done).to.be.false;
      expect(state.rerollsUsed).to.equal(0);
      expect(this.variables.all).to.have.length(1);
    },
  }),

  createModuleTest({
    name: 'kill quest: filter, milestone PM, completion pays and remembers the payout',
    module: MODULE,
    now: NOW,
    currency: 0,
    userConfig: { quests: [KILL], milestonePercents: [50] },
    setup: function () {
      seed.call(this, { quests: [active(KILL)] });
    },
    test: async function () {
      const wolf = await this.runHook('on-entity-killed', { eventData: { entity: 'animalWolf' } });
      expect(wolf.success, JSON.stringify(wolf.logs)).to.be.true;
      expect(stateOf(this, this.pog.playerId).quests[0].progress).to.equal(0);

      await this.runHook('on-entity-killed', { eventData: { entity: 'zombieJanitor' } });
      expect(this.pms()).to.deep.equal([]);
      await this.runHook('on-entity-killed', { eventData: { entity: 'ZombieBoe' } });
      expect(this.pms()).to.deep.equal(['Quest progress: Kill 4 zombies - 2/4']);
      await this.runHook('on-entity-killed', { eventData: { entity: 'zombieArlene' } });
      await this.runHook('on-entity-killed', { eventData: { entity: 'zombieArlene' } });

      const state = stateOf(this, this.pog.playerId);
      expect(state.quests[0].done).to.be.true;
      expect(state.quests[0].progress).to.equal(4);
      expect(state.ignoreCredits).to.deep.equal([100]);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(100);
      expect(this.pms()).to.include('Quest complete: Kill 4 zombies! Reward: 100 test coin.');
      expect(this.pms()).to.include('All daily quests done! New quests after the daily reset.');

      // A fifth kill after completion changes nothing and pays nothing.
      await this.runHook('on-entity-killed', { eventData: { entity: 'zombieArlene' } });
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(100);
    },
  }),

  createModuleTest({
    name: 'all-quests bonus is paid once',
    module: MODULE,
    now: NOW,
    currency: 0,
    userConfig: { quests: [DEATH, KILL], allCompleteBonus: 500 },
    setup: function () {
      seed.call(this, { quests: [active(DEATH), active(KILL, 4, true)] });
    },
    test: async function () {
      await this.runHook('on-player-death', { eventData: {} });
      await this.runHook('on-player-death', { eventData: {} });
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(501);
      expect(stateOf(this, this.pog.playerId).ignoreCredits).to.deep.equal([1, 500]);
      expect(this.pms()).to.include('All daily quests done! Bonus: 500 test coin. New quests after the daily reset.');
    },
  }),

  createModuleTest({
    name: 'chat quest ignores commands and short messages',
    module: MODULE,
    now: NOW,
    userConfig: { quests: [CHAT] },
    setup: function () {
      seed.call(this, { quests: [active(CHAT)] });
    },
    test: async function () {
      await this.runHook('on-chat-message', { eventData: { msg: '/quests', channel: 'global' } });
      await this.runHook('on-chat-message', { eventData: { msg: 'hi', channel: 'global' } });
      await this.runHook('on-chat-message', { eventData: { msg: 'hello everyone', channel: 'global' } });
      expect(stateOf(this, this.pog.playerId).quests[0].progress).to.equal(1);
      // Server messages carry no player.
      const server = await this.runHook('on-chat-message', { eventData: { msg: 'welcome' }, withPlayer: false });
      expect(server.success, JSON.stringify(server.logs)).to.be.true;
      expect(stateOf(this, this.pog.playerId).quests[0].progress).to.equal(1);
    },
  }),

  createModuleTest({
    name: 'command quest is picked when the command is installed and counts successful runs only',
    module: MODULE,
    now: NOW,
    random: 0,
    currency: 0,
    alsoInstalled: [{ module: DAILY_REWARDS }],
    userConfig: { questsPerDay: 1, quests: [DAILY] },
    test: async function () {
      await this.runCommand('quests');
      expect(stateOf(this, this.pog.playerId).quests[0].id).to.equal('claim-daily');

      await this.runHook('on-command-executed', {
        eventData: { command: { name: 'daily' }, result: { success: false } },
      });
      await this.runHook('on-command-executed', { eventData: { command: { name: 'teleport' }, result: { success: true } } });
      expect(stateOf(this, this.pog.playerId).quests[0].done).to.be.false;

      await this.runHook('on-command-executed', { eventData: { command: { name: 'daily' }, result: { success: true } } });
      expect(stateOf(this, this.pog.playerId).quests[0].done).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(25);
    },
  }),

  createModuleTest({
    name: 'shop quest matches listing or item names',
    module: MODULE,
    now: NOW,
    currency: 0,
    userConfig: { quests: [SHOP] },
    setup: function () {
      seed.call(this, { quests: [active(SHOP)] });
    },
    test: async function () {
      await this.runHook('on-shop-order', { eventData: { listingName: 'Med kit', items: [{ name: 'Bandage' }] } });
      expect(stateOf(this, this.pog.playerId).quests[0].done).to.be.false;
      await this.runHook('on-shop-order', { eventData: { listingName: 'Bundle', items: [{ name: 'Duct Tape' }] } });
      expect(stateOf(this, this.pog.playerId).quests[0].done).to.be.true;
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(5);
    },
  }),

  createModuleTest({
    name: "currency quest counts earnings but not this module's own payouts",
    module: MODULE,
    now: NOW,
    userConfig: { quests: [EARN] },
    setup: function () {
      seed.call(this, { quests: [active(EARN)], ignoreCredits: [100] });
    },
    test: async function () {
      await this.runHook('on-currency-added', { eventData: { amount: 100 } });
      let state = stateOf(this, this.pog.playerId);
      expect(state.quests[0].progress).to.equal(0);
      expect(state.ignoreCredits).to.deep.equal([]);

      await this.runHook('on-currency-added', { eventData: { amount: 150 } });
      await this.runHook('on-currency-added', { eventData: { amount: 100 } });
      state = stateOf(this, this.pog.playerId);
      expect(state.quests[0].done).to.be.true;
      expect(state.quests[0].progress).to.equal(200);
      // The 50 payout is now expected as a self-credit.
      expect(state.ignoreCredits).to.deep.equal([50]);
      await this.runHook('on-currency-added', { eventData: { amount: 50 } });
      expect(stateOf(this, this.pog.playerId).ignoreCredits).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'item rewards are given',
    module: MODULE,
    now: NOW,
    userConfig: { quests: [quest('die', 'death', 1, { rewardItems: [{ item: 'resourceDuctTape', amount: 3 }] })] },
    setup: function () {
      seed.call(this, { quests: [active(quest('die', 'death', 1, { rewardItems: [{ item: 'resourceDuctTape', amount: 3 }] }))] });
      this.client.stubs.item?.itemControllerFindOne?.rejects(new Error('not found'));
    },
    test: async function () {
      const res = await this.runHook('on-player-death', { eventData: {} });
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerGiveItem).to.have.been.calledWith(
        this.gameServerId,
        this.pog.playerId,
        { name: 'resourceDuctTape', amount: 3, quality: '' },
      );
      expect(this.pms()).to.include('Quest complete: Die 1 times! Reward: 3x resourceDuctTape.');
    },
  }),

  createModuleTest({
    name: 'playtime tick counts minutes since the last tick, and ignores long gaps',
    module: MODULE,
    now: NOW,
    userConfig: { quests: [PLAY] },
    otherPlayers: [{ name: 'Away' }],
    setup: function () {
      seed.call(this, { quests: [active(PLAY, 10)], lastTick: new Date(NOW.getTime() - 5 * 60000).toISOString() });
      seed.call(
        this,
        { quests: [active(PLAY, 10)], lastTick: new Date(NOW.getTime() - 60 * 60000).toISOString() },
        this.otherPlayers[0].pog.playerId,
      );
    },
    test: async function () {
      const res = await this.runCronJob('playtime-tick');
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      const me = stateOf(this, this.pog.playerId);
      expect(me.quests[0].progress).to.equal(15);
      expect(me.lastTick).to.equal(NOW.toISOString());
      const other = stateOf(this, this.otherPlayers[0].pog.playerId);
      expect(other.quests[0].progress).to.equal(10);
      expect(other.lastTick).to.equal(NOW.toISOString());
    },
  }),

  createModuleTest({
    name: 'daily reset only acts at the reset hour and PMs new quests',
    module: MODULE,
    now: NOW,
    random: 0,
    userConfig: { resetHourUtc: 10, questsPerDay: 1, quests: [KILL] },
    test: async function () {
      const res = await this.runCronJob('daily-reset');
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(stateOf(this, this.pog.playerId).day).to.equal(TODAY);
      const pms = this.pms();
      expect(pms[0]).to.equal('New daily quests!');
      expect(pms[1]).to.contain('1. Kill 4 zombies - 0/4');
      expect(pms[pms.length - 1]).to.equal('Type /quests for progress.');
      expect(pms.every((m: string) => !m.includes('\n'))).to.be.true;
      // A second run the same hour does nothing new.
      await this.runCronJob('daily-reset');
      expect(this.pms()).to.have.length(pms.length);
    },
  }),

  createModuleTest({
    name: 'daily reset skips other hours',
    module: MODULE,
    now: NOW,
    userConfig: { resetHourUtc: 3, quests: [KILL] },
    test: async function () {
      await this.runCronJob('daily-reset');
      expect(this.variables.all).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'reroll swaps an open quest and charges the cost',
    module: MODULE,
    now: NOW,
    random: 0,
    currency: 500,
    userConfig: { quests: [KILL, CHAT, EARN], rerollCost: 100, rerollsPerDay: 1 },
    setup: function () {
      seed.call(this, { quests: [active(KILL, 2), active(CHAT)] });
    },
    test: async function () {
      const res = await this.runCommand('questreroll', { number: 1 });
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      const state = stateOf(this, this.pog.playerId);
      expect(state.quests.map((q: { id: string }) => q.id)).to.deep.equal(['earn-200', 'chat-3']);
      expect(state.rerollsUsed).to.equal(1);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(400);
      expect(this.pms()[0]).to.equal(
        'Swapped "Kill 4 zombies" for "Earn 200 test coin" for 100 test coin. Rerolls left today: 0.',
      );

      const again = await this.runCommand('questreroll', { number: 2 });
      expect(this.userError(again)).to.equal('You used all 1 reroll(s) for today. Try again after the daily reset.');
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(400);
    },
  }),

  createModuleTest({
    name: 'reroll refuses bad numbers, done quests and empty wallets',
    module: MODULE,
    now: NOW,
    currency: 50,
    userConfig: { quests: [KILL, CHAT, EARN], rerollCost: 100 },
    setup: function () {
      seed.call(this, { quests: [active(KILL, 4, true), active(CHAT)] });
    },
    test: async function () {
      expect(this.userError(await this.runCommand('questreroll'))).to.equal(
        'Pick a quest number from 1 to 2. See /quests, then /questreroll <number>.',
      );
      expect(this.userError(await this.runCommand('questreroll', { number: 1 }))).to.equal(
        'That quest is already done. Pick an open quest.',
      );
      expect(this.userError(await this.runCommand('questreroll', { number: 2 }))).to.equal(
        'A reroll costs 100 test coin. You have 50.',
      );
      expect(this.client.stubs.playerOnGameserver.playerOnGameServerControllerDeductCurrency).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'reroll with nothing else in the pool',
    module: MODULE,
    now: NOW,
    currency: 500,
    userConfig: { quests: [KILL], rerollCost: 0 },
    setup: function () {
      seed.call(this, { quests: [active(KILL)] });
    },
    test: async function () {
      expect(this.userError(await this.runCommand('questreroll', { number: 1 }))).to.equal(
        'There are no other quests to swap to right now.',
      );
    },
  }),

  createModuleTest({
    name: 'rerolls disabled',
    module: MODULE,
    now: NOW,
    userConfig: { quests: [KILL], rerollsPerDay: 0 },
    test: async function () {
      expect(this.userError(await this.runCommand('questreroll', { number: 1 }))).to.equal(
        'Quest rerolls are disabled on this server.',
      );
    },
  }),
];

describe('daily-quests suite (module-VM)', function () {
  tests.forEach((test) => test.run());
});
