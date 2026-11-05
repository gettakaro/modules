import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, paginated, single } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const group = 'weekly-top-rewards suite (module-VM)';

const NOW = new Date('2026-11-08T20:00:00.000Z');
const PERIOD_START = '2026-11-01T20:00:00.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const OTHER_MODULE_ID = '5c1f0a2e-7d43-4b8a-9e61-2f3a4b5c6d7e';
const ROLE_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SWORD = { item: 'sword-id', amount: 2, quality: '' };

type Pogish = { playerId: string; online?: boolean };
type Ctx = {
  pog: Pogish;
  otherPlayers: Array<{ pog: Pogish }>;
  gameServerId: string;
  moduleId: string;
  client: { stubs: any };
};

type Session = { eventName: 'player-connected' | 'player-disconnected'; playerId: string; createdAt: string };

/** Players seen this period; the fake can't answer `greaterThan` / `online`, so it is stubbed. */
function stubPogs(t: Ctx, lastSeen: Record<number, string> = {}) {
  const all = [t.pog, ...t.otherPlayers.map((o) => o.pog)];
  t.client.stubs.playerOnGameserver.playerOnGameServerControllerSearch?.callsFake(async () =>
    paginated(
      all.map((p, i) => ({
        ...p,
        online: p.online !== false,
        lastSeen: lastSeen[i] ?? NOW.toISOString(),
        playtimeSeconds: 0,
        createdAt: OLD,
      })),
    ),
  );
}

const at = (iso: string, seconds: number) => new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
const conn = (playerId: string, createdAt: string): Session => ({ eventName: 'player-connected', playerId, createdAt });
const disc = (playerId: string, createdAt: string): Session => ({ eventName: 'player-disconnected', playerId, createdAt });

/** Kill counts per player id (fallback path: analytics is not in the fake), currency-added and session events. */
function stubEvents(t: Ctx, kills: Record<string, number>, currencyEvents: unknown[], sessions: Session[] = []) {
  t.client.stubs.event.eventControllerSearch?.callsFake(async (query: any) => {
    const name = query.filters.eventName[0];
    if (name === 'entity-killed') {
      const count = kills[query.filters.playerId[0]] ?? 0;
      return paginated([], { total: count });
    }
    if (name === 'currency-added') return paginated(query.page === 0 ? currencyEvents : []);
    if (name === 'player-connected') {
      expect(query.filters.eventName).to.deep.equal(['player-connected', 'player-disconnected']);
      return paginated(query.page === 0 ? sessions : []);
    }
    throw new Error(`unexpected event query ${name}`);
  });
}

function seedState(t: Ctx & { variables: any }, extra: Record<string, unknown>) {
  t.variables.insert({
    key: 'wtr_state',
    value: JSON.stringify({ periodStart: PERIOD_START, ...extra }),
    gameServerId: t.gameServerId,
    moduleId: t.moduleId,
  });
}

function stateRow(t: { variables: any; moduleId: string }) {
  return t.variables.all.find((r: any) => r.key === 'wtr_state' && r.moduleId === t.moduleId);
}

const LIVE_CHANNEL = '998877665544';

/** discordControllerUpdateMessage is not in the fake; record calls on a plain function. */
function stubDiscordLive(t: Ctx, opts: { failUpdate?: boolean } = {}) {
  const updates: unknown[][] = [];
  let sent = 0;
  t.client.stubs.discord.discordControllerSendMessage?.callsFake(async (channelId: string) => {
    sent += 1;
    return single({ id: `msg-${sent}`, channelId, guildId: 'g1' });
  });
  t.client.stubs.discord.discordControllerUpdateMessage = async (...args: unknown[]) => {
    updates.push(args);
    if (opts.failUpdate) throw new Error('Unknown Message');
    return single({ id: args[1], channelId: args[0], guildId: 'g1' });
  };
  return updates;
}

function liveRow(t: { variables: any; moduleId: string }) {
  const row = t.variables.all.find((r: any) => r.key === 'wtr_discord_live' && r.moduleId === t.moduleId);
  return row ? JSON.parse(row.value) : null;
}

const players = [{ name: 'Bravo' }, { name: 'Charlie', online: false }, { name: 'Delta' }];

const tests = [
  createModuleTest({
    name: 'First /weeklytop starts tracking and stores who is online',
    module: MODULE,
    now: NOW,
    otherPlayers: players,
    setup: function () {
      stubPogs(this as unknown as Ctx);
    },
    test: async function () {
      const result = await this.runCommand('weeklytop');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Weekly Top tracking just started. Play, and check back later!']);
      const state = JSON.parse(stateRow(this).value);
      expect(state.periodStart).to.equal(NOW.toISOString());
      // Charlie is offline, so only the other three have a session open at the start.
      const [b, , d] = this.otherPlayers.map((o) => o.pog.playerId);
      expect(state.onlineAtStart).to.deep.equal([this.pog.playerId, b, d]);
    },
  }),

  createModuleTest({
    name: '/weeklytop shows top 3 per category and the caller rank',
    module: MODULE,
    now: NOW,
    otherPlayers: players,
    userConfig: { minimumPlaytimeMinutes: 10 },
    setup: function () {
      const t = this as unknown as Ctx;
      const [b, c, d] = t.otherPlayers.map((o) => o.pog.playerId);
      seedState(this as any, { onlineAtStart: [t.pog.playerId, d] });
      // Charlie (offline) lost his disconnect event: his session ends at lastSeen.
      stubPogs(t, { 2: at(PERIOD_START, 86400 + 3600) });
      const sessions = [
        // Me: online when the week started, left after 10 min.
        disc(t.pog.playerId, at(PERIOD_START, 600)),
        conn(c, at(PERIOD_START, 86400)),
        // Delta: a connect without disconnect is dropped, then a 30 min session.
        conn(d, at(PERIOD_START, 90000)),
        conn(d, at(PERIOD_START, 95000)),
        disc(d, at(PERIOD_START, 95000 + 1800)),
        // Bravo: still online, his running session counts up to now.
        conn(b, at(NOW.toISOString(), -7200)),
      ];
      stubEvents(t, { [t.pog.playerId]: 4, [b]: 10, [c]: 0, [d]: 25 }, [
        { playerId: c, actingModuleId: OTHER_MODULE_ID, meta: { amount: 300 } },
        { playerId: c, actingModuleId: OTHER_MODULE_ID, meta: { amount: 200 } },
        { playerId: t.pog.playerId, actingModuleId: OTHER_MODULE_ID, meta: { amount: 50 } },
        // Own payouts and manual grants are ignored by default.
        { playerId: b, actingModuleId: t.moduleId, meta: { amount: 9999 } },
        { playerId: d, actingModuleId: null, actingUserId: 'admin', meta: { amount: 8888 } },
      ], sessions);
    },
    test: async function () {
      const result = await this.runCommand('weeklytop');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const pms = this.pms();
      expect(pms[0]).to.equal('Weekly Top since Sun 2026-11-01 20:00 UTC:');
      expect(pms[1]).to.equal('Playtime: 1. Bravo (2h)  2. Charlie (1h)  3. Delta (30m) | You: #4 (10m)');
      expect(pms[2]).to.equal('Kills: 1. Delta (25 kills)  2. Bravo (10 kills)  3. Test player (4 kills) | You: #3 (4 kills)');
      expect(pms[3]).to.equal('Earned: 1. Charlie (500 test coin)  2. Test player (50 test coin) | You: #2 (50 test coin)');
      expect(pms).to.have.length(4);
    },
  }),

  createModuleTest({
    name: '/weeklytop with an unknown category explains the options',
    module: MODULE,
    now: NOW,
    test: async function () {
      const result = await this.runCommand('weeklytop', { category: 'deaths' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(
        'Unknown category "deaths". Try: /weeklytop playtime | /weeklytop kills | /weeklytop currency | /weeklytop last',
      );
    },
  }),

  createModuleTest({
    name: '/weeklytop for a disabled category is refused',
    module: MODULE,
    now: NOW,
    userConfig: { categories: ['playtime'] },
    test: async function () {
      const result = await this.runCommand('weeklytop', { category: 'kills' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.contain('Unknown category "kills"');
    },
  }),

  createModuleTest({
    name: 'First cron run only starts the week and pays nobody',
    module: MODULE,
    now: NOW,
    otherPlayers: players,
    setup: function () {
      stubPogs(this as unknown as Ctx);
    },
    test: async function () {
      const result = await this.runCronJob('award-weekly');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages.map((m) => m.message)).to.deep.equal([
        "Weekly Top has started! Type /weeklytop to see this week's standings.",
      ]);
      expect(JSON.parse(stateRow(this).value).periodStart).to.equal(NOW.toISOString());
      expect(this.client.stubs.playerOnGameserver.playerOnGameServerControllerAddCurrency).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'Cron pays the top 3, queues items for offline winners, grants the role and starts a new week',
    module: MODULE,
    now: NOW,
    otherPlayers: players,
    userConfig: {
      categories: ['playtime'],
      minimumPlaytimeMinutes: 0,
      currencyRewards: [500, 250, 100],
      firstPlaceItems: [SWORD],
      secondPlaceItems: [SWORD],
      rewardRoleId: ROLE_ID,
      rewardRoleDays: 7,
      discordChannelId: '123456789',
    },
    setup: function () {
      const t = this as unknown as Ctx;
      const [b, c, d] = t.otherPlayers.map((o) => o.pog.playerId);
      // State from 1.0.0 (lifetime snapshot, no onlineAtStart): a first event that is a disconnect
      // means the player was online when the week started.
      seedState(this as any, { playtime: { [c]: 99999 } });
      stubPogs(t);
      // Charlie (offline) 1st, Delta 2nd, me 3rd, Bravo 4th.
      stubEvents(t, {}, [], [
        disc(c, at(PERIOD_START, 3600)),
        conn(t.pog.playerId, at(PERIOD_START, 7200)),
        disc(t.pog.playerId, at(PERIOD_START, 7800)),
        conn(b, at(PERIOD_START, 9000)),
        disc(b, at(PERIOD_START, 9300)),
        conn(d, at(NOW.toISOString(), -1800)),
      ]);
    },
    test: async function () {
      const [b, c, d] = this.otherPlayers.map((o) => o.pog.playerId);
      const result = await this.runCronJob('award-weekly');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;

      expect(this.currency.balanceOf(c)).to.equal(500);
      expect(this.currency.balanceOf(d)).to.equal(250);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(100);
      expect(this.currency.balanceOf(b)).to.equal(0);

      // Delta is online: item given now. Charlie is offline: item queued.
      const give = this.client.stubs.gameserver.gameServerControllerGiveItem!;
      expect(give).to.have.been.calledOnce;
      expect(give.firstCall.args[1]).to.equal(d);
      const pending = this.variables.all.find((r) => r.key === 'wtr_pending_items');
      expect(pending?.playerId).to.equal(c);
      expect(JSON.parse(pending!.value)).to.deep.equal([SWORD]);

      const assign = this.client.stubs.player.playerControllerAssignRole!;
      expect(assign.callCount).to.equal(3);
      expect(assign.firstCall.args).to.deep.equal([
        c,
        ROLE_ID,
        { gameServerId: this.gameServerId, expiresAt: '2026-11-15T20:00:00.000Z' },
      ]);

      expect(this.messages.map((m) => m.message)).to.deep.equal([
        'Weekly Top results are in!',
        'Playtime: 1. Charlie (1h)  2. Delta (30m)  3. Test player (10m)',
        'Prizes: 500 / 250 / 100 test coin for places 1-3.',
        'A new week has started. Type /weeklytop to see the standings.',
      ]);

      const discord = this.client.stubs.discord.discordControllerSendMessage!;
      expect(discord).to.have.been.calledOnce;
      expect(discord.firstCall.args[0]).to.equal('123456789');
      expect(discord.firstCall.args[1]?.message).to.contain('**Weekly Top results**');

      const state = JSON.parse(stateRow(this).value);
      expect(state.periodStart).to.equal(NOW.toISOString());
      expect(state.onlineAtStart).to.deep.equal([this.pog.playerId, b, d]);
      expect(state.playtime).to.equal(undefined);

      const last = JSON.parse(this.variables.all.find((r) => r.key === 'wtr_last_results')!.value);
      expect(last.periodStart).to.equal(PERIOD_START);
      expect(last.categories.playtime.map((w: any) => w.name)).to.deep.equal(['Charlie', 'Delta', 'Test player']);
    },
  }),

  createModuleTest({
    name: 'Cron with broadcasts off and nobody qualifying stays quiet and pays nothing',
    module: MODULE,
    now: NOW,
    otherPlayers: players,
    userConfig: { categories: ['playtime'], broadcastResults: false, minimumPlaytimeMinutes: 60 },
    setup: function () {
      const t = this as unknown as Ctx;
      seedState(this as any, { onlineAtStart: [] });
      stubPogs(t);
      stubEvents(t, {}, [], [conn(t.pog.playerId, at(PERIOD_START, 60)), disc(t.pog.playerId, at(PERIOD_START, 660))]);
    },
    test: async function () {
      const result = await this.runCronJob('award-weekly');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.have.length(0);
      expect(this.client.stubs.playerOnGameserver.playerOnGameServerControllerAddCurrency).to.not.have.been.called;
      expect(this.client.stubs.discord.discordControllerSendMessage).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: '/weeklytop last shows the previous winners',
    module: MODULE,
    now: NOW,
    setup: function () {
      this.variables.insert({
        key: 'wtr_last_results',
        value: JSON.stringify({
          periodStart: PERIOD_START,
          periodEnd: NOW.toISOString(),
          categories: { kills: [{ place: 1, playerId: 'x', name: 'Alpha', value: 42 }], currency: [] },
        }),
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
      });
    },
    test: async function () {
      const result = await this.runCommand('weeklytop', { category: 'last' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        "Last week's winners (Sun 2026-11-01 20:00 UTC - Sun 2026-11-08 20:00 UTC):",
        'Kills: 1. Alpha (42 kills)',
        'Earned: no qualifying players',
      ]);
    },
  }),

  createModuleTest({
    name: 'Login hook delivers queued item prizes once',
    module: MODULE,
    now: NOW,
    setup: function () {
      this.variables.insert({
        key: 'wtr_pending_items',
        value: JSON.stringify([SWORD]),
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
        playerId: this.pog.playerId,
      });
    },
    test: async function () {
      const result = await this.runHook('deliver-pending');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const give = this.client.stubs.gameserver.gameServerControllerGiveItem!;
      expect(give).to.have.been.calledOnce;
      expect(give.firstCall.args[2]).to.deep.equal({ name: 'sword-id', amount: 2, quality: '' });
      expect(this.pms()).to.deep.equal(['Your Weekly Top prize is here: 1 item reward delivered.']);
      expect(this.variables.all.filter((r) => r.key === 'wtr_pending_items')).to.have.length(0);

      const again = await this.runHook('deliver-pending');
      expect(again.success).to.be.true;
      expect(give).to.have.been.calledOnce;
    },
  }),

  createModuleTest({
    name: 'Live Discord cron does nothing without a channel',
    module: MODULE,
    now: NOW,
    test: async function () {
      const result = await this.runCronJob('update-discord-leaderboard');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.variable.variableControllerSearch).to.not.have.been.called;
      expect(this.client.stubs.discord.discordControllerSendMessage).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'Live Discord cron posts one embed, then edits that same message',
    module: MODULE,
    now: NOW,
    otherPlayers: players,
    userConfig: { categories: ['playtime'], minimumPlaytimeMinutes: 0, discordLiveChannelId: LIVE_CHANNEL, discordLiveSize: 3 },
    setup: function () {
      const t = this as unknown as Ctx;
      const [b, c, d] = t.otherPlayers.map((o) => o.pog.playerId);
      seedState(this as any, { onlineAtStart: [] });
      stubPogs(t);
      stubEvents(t, {}, [], [
        conn(t.pog.playerId, PERIOD_START),
        conn(b, PERIOD_START),
        conn(c, PERIOD_START),
        conn(d, PERIOD_START),
        disc(b, at(PERIOD_START, 300)),
        disc(t.pog.playerId, at(PERIOD_START, 600)),
        disc(d, at(PERIOD_START, 1800)),
        disc(c, at(PERIOD_START, 3600)),
      ]);
    },
    test: async function () {
      const updates = stubDiscordLive(this as unknown as Ctx);
      const send = this.client.stubs.discord.discordControllerSendMessage!;

      const first = await this.runCronJob('update-discord-leaderboard');
      expect(first.success, JSON.stringify(first.logs)).to.be.true;
      expect(send).to.have.been.calledOnce;
      expect(send.firstCall.args[0]).to.equal(LIVE_CHANNEL);
      const embed = (send.firstCall.args[1] as any).embed;
      expect(embed.title).to.equal('Weekly Top - live standings');
      expect(embed.fields).to.deep.equal([
        {
          name: 'Playtime',
          value: '**1.** Charlie - 1h\n**2.** Delta - 30m\n**3.** Test player - 10m',
          inline: true,
        },
      ]);
      expect(liveRow(this)).to.deep.equal({ channelId: LIVE_CHANNEL, messageId: 'msg-1', periodStart: PERIOD_START });

      const second = await this.runCronJob('update-discord-leaderboard');
      expect(second.success, JSON.stringify(second.logs)).to.be.true;
      expect(send).to.have.been.calledOnce;
      expect(updates).to.have.length(1);
      expect(updates[0].slice(0, 2)).to.deep.equal([LIVE_CHANNEL, 'msg-1']);
    },
  }),

  createModuleTest({
    name: 'Live Discord cron posts a replacement when the old message is gone',
    module: MODULE,
    now: NOW,
    userConfig: { categories: ['playtime'], discordLiveChannelId: LIVE_CHANNEL },
    setup: function () {
      seedState(this as any, { onlineAtStart: [] });
      stubPogs(this as unknown as Ctx);
      stubEvents(this as unknown as Ctx, {}, [], []);
      this.variables.insert({
        key: 'wtr_discord_live',
        value: JSON.stringify({ channelId: LIVE_CHANNEL, messageId: 'deleted', periodStart: PERIOD_START }),
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
      });
    },
    test: async function () {
      const updates = stubDiscordLive(this as unknown as Ctx, { failUpdate: true });
      const result = await this.runCronJob('update-discord-leaderboard');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(updates).to.have.length(1);
      expect(this.client.stubs.discord.discordControllerSendMessage).to.have.been.calledOnce;
      const embed = (this.client.stubs.discord.discordControllerSendMessage!.firstCall.args[1] as any).embed;
      expect(embed.fields[0].value).to.equal('Nobody yet.');
      expect(liveRow(this).messageId).to.equal('msg-1');
    },
  }),

  createModuleTest({
    name: 'Award cron turns the live message into final results and the next week gets a new message',
    module: MODULE,
    now: NOW,
    otherPlayers: [{ name: '@everyone' }],
    userConfig: { categories: ['playtime'], minimumPlaytimeMinutes: 0, broadcastResults: false, discordLiveChannelId: LIVE_CHANNEL },
    setup: function () {
      const t = this as unknown as Ctx;
      const e = t.otherPlayers[0].pog.playerId;
      seedState(this as any, { onlineAtStart: [] });
      stubPogs(t);
      stubEvents(t, {}, [], [
        conn(t.pog.playerId, PERIOD_START),
        conn(e, PERIOD_START),
        disc(t.pog.playerId, at(PERIOD_START, 600)),
        disc(e, at(PERIOD_START, 1200)),
      ]);
      this.variables.insert({
        key: 'wtr_discord_live',
        value: JSON.stringify({ channelId: LIVE_CHANNEL, messageId: 'live-1', periodStart: PERIOD_START }),
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
      });
    },
    test: async function () {
      const updates = stubDiscordLive(this as unknown as Ctx);
      const result = await this.runCronJob('award-weekly');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(updates).to.have.length(1);
      expect(updates[0].slice(0, 2)).to.deep.equal([LIVE_CHANNEL, 'live-1']);
      const embed = (updates[0][2] as any).embed;
      expect(embed.title).to.equal('Weekly Top - final results');
      // Player names cannot ping the server.
      expect(embed.fields[0].value).to.equal('**1.** @\u200beveryone - 20m\n**2.** Test player - 10m');
      expect(this.client.stubs.discord.discordControllerSendMessage).to.not.have.been.called;

      // The stored message still belongs to the closed week, so the next live run posts a fresh one.
      const next = await this.runCronJob('update-discord-leaderboard');
      expect(next.success, JSON.stringify(next.logs)).to.be.true;
      expect(this.client.stubs.discord.discordControllerSendMessage).to.have.been.calledOnce;
      expect(liveRow(this).periodStart).to.equal(NOW.toISOString());
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
