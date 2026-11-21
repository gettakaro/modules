import { expect } from '../../../../test/support/expect.ts';
import { describe, afterEach } from 'node:test';
import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import { createModuleTest } from '@takaro/module-test';
import type { ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const group = 'steam-profile-guard (module-VM)';
const HOOK = 'check-on-join';
const NOW = new Date('2026-01-01T00:00:00.000Z');
const STEAM_ID = '76561198000000001';
const KEY = 'test-key';

const ADMIN_GAME_ID = 'admin-game-id';
const ADMIN = {
  name: 'Admin',
  gameId: ADMIN_GAME_ID,
  permissions: [{ permission: 'STEAM_GUARD_ALERTS' }],
};

/**
 * A fake Steam Web API at the HTTP transport. The module's own code builds the URLs and parses the replies;
 * only the network hop is replaced. Paths not in `replies` answer 404.
 */
type Reply = { status?: number; body: unknown };
let requests: string[] = [];
function fakeSteam(replies: Record<string, Reply>) {
  requests = [];
  axios.defaults.adapter = async (config: AxiosRequestConfig) => {
    const url = new URL(config.url ?? '');
    requests.push(`${url.pathname}?${url.search.slice(1)}`);
    const reply = replies[url.pathname] ?? { status: 404, body: {} };
    const response = {
      data: reply.body,
      status: reply.status ?? 200,
      statusText: '',
      headers: {},
      config,
    };
    if (response.status >= 400) {
      const err = new axios.AxiosError(`Request failed with status code ${response.status}`, 'ERR_BAD_RESPONSE');
      (err as unknown as { response: unknown }).response = response;
      throw err;
    }
    return response as never;
  };
}
afterEach(() => {
  axios.defaults.adapter = undefined;
});

const DAY = 24 * 3600;
const nowSec = NOW.getTime() / 1000;

function steamReplies(o: {
  visibility?: number;
  createdDaysAgo?: number | null;
  level?: number | null;
  vac?: number;
  gameBans?: number;
  daysSinceLastBan?: number;
  games?: { appid: number; playtime_forever: number }[] | null;
  lender?: string;
}): Record<string, Reply> {
  const player: Record<string, unknown> = {
    steamid: STEAM_ID,
    communityvisibilitystate: o.visibility ?? 3,
  };
  if (o.createdDaysAgo !== null) player.timecreated = nowSec - (o.createdDaysAgo ?? 3000) * DAY;
  return {
    '/ISteamUser/GetPlayerSummaries/v2/': {
      body: { response: { players: [player] } },
    },
    '/ISteamUser/GetPlayerBans/v1/': {
      body: {
        players: [
          {
            SteamId: STEAM_ID,
            CommunityBanned: false,
            VACBanned: (o.vac ?? 0) > 0,
            NumberOfVACBans: o.vac ?? 0,
            DaysSinceLastBan: o.daysSinceLastBan ?? 0,
            NumberOfGameBans: o.gameBans ?? 0,
            EconomyBan: 'none',
          },
        ],
      },
    },
    '/IPlayerService/GetSteamLevel/v1/': {
      body: {
        response: o.level === null ? {} : { player_level: o.level ?? 20 },
      },
    },
    '/IPlayerService/GetOwnedGames/v1/': {
      body: {
        response: o.games === null ? {} : { game_count: (o.games ?? []).length, games: o.games ?? [] },
      },
    },
    '/IPlayerService/IsPlayingSharedGame/v1/': {
      body: { response: { lender_steamid: o.lender ?? '0' } },
    },
    '/ISteamWebAPIUtil/GetServerInfo/v1/': {
      body: {
        servertime: nowSec,
        servertimestring: 'Thu Jan  1 00:00:00 2026',
      },
    },
  };
}

function adminPms(test: ModuleTest): string[] {
  return test.client.pmsTo(ADMIN_GAME_ID);
}

const base = {
  module: MODULE,
  now: NOW,
  permissions: [] as { permission: string }[],
  player: { name: 'Newbie', steamId: STEAM_ID },
  otherPlayers: [ADMIN],
};

const tests = [
  createModuleTest({
    ...base,
    name: 'A 5-day-old account alerts admins only (default action) and the answer is cached',
    userConfig: { steamApiKey: KEY, discordChannelId: '123' },
    setup: () => fakeSteam(steamReplies({ createdDaysAgo: 5 })),
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(adminPms(this)).to.deep.equal([
        `[Steam guard] Newbie (${STEAM_ID}): FLAGGED: account 5 days old (min 30). Action: alert only.`,
      ]);
      expect(this.pms()).to.deep.equal([]);
      expect(this.client.stubs.discord.discordControllerSendMessage).to.have.been.calledOnceWith('123');
      expect(this.client.stubs.gameserver.gameServerControllerKickPlayer).to.not.have.been.called;
      expect(requests[0]).to.equal(`/ISteamUser/GetPlayerSummaries/v2/?key=${KEY}&steamids=${STEAM_ID}`);
      // Level, hours and family sharing are off by default, so Steam is asked only twice.
      expect(requests).to.have.length(2);
      const cache = this.variables.all.find((v) => v.key === 'spg:profile')!;
      expect(cache.expiresAt).to.equal(new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString());

      // Second join: same findings, served from the cache, admins not alerted again.
      requests = [];
      const again = await this.runHook(HOOK);
      expect(again.success, JSON.stringify(again.logs)).to.be.true;
      expect(requests).to.deep.equal([]);
      expect(adminPms(this)).to.have.length(1);
    },
  }),

  createModuleTest({
    ...base,
    name: 'A clean, old public profile passes without alerts',
    userConfig: {
      steamApiKey: KEY,
      minSteamLevel: 5,
      minGameHours: 10,
      appId: 251570,
    },
    setup: () =>
      fakeSteam(
        steamReplies({
          level: 20,
          games: [{ appid: 251570, playtime_forever: 6000 }],
        }),
      ),
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(adminPms(this)).to.deep.equal([]);
      expect(requests.some((r) => r.includes('appids_filter%5B0%5D=251570'))).to.be.true;
      const status = JSON.parse(this.variables.all.find((v) => v.key === 'spg:status')!.value);
      expect(status.status).to.equal('clean');
    },
  }),

  createModuleTest({
    ...base,
    name: 'Low level, few hours, private profile and a recent VAC ban: ban beats kick',
    userConfig: {
      steamApiKey: KEY,
      flagPrivateProfile: true,
      privateAction: 'kick',
      minSteamLevel: 5,
      minGameHours: 10,
      appId: 251570,
      banAction: 'ban',
      banDuration: 0,
      actionReason: 'Alt accounts not allowed',
    },
    setup: () =>
      fakeSteam(
        steamReplies({
          visibility: 1,
          createdDaysAgo: null,
          level: 1,
          vac: 1,
          daysSinceLastBan: 40,
          games: [{ appid: 251570, playtime_forever: 90 }],
        }),
      ),
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.player.banControllerCreate).to.have.been.calledOnceWith({
        gameServerId: this.gameServerId,
        playerId: this.player.id,
        reason: 'Alt accounts not allowed',
      });
      expect(this.client.stubs.gameserver.gameServerControllerKickPlayer).to.not.have.been.called;
      expect(adminPms(this)).to.deep.equal([
        `[Steam guard] Newbie (${STEAM_ID}): FLAGGED: private Steam profile; Steam level 1 (min 5); 1.5h in this game (min 10); 1 VAC ban(s), last 40 days ago (flag < 365). Action: banned permanently.`,
      ]);
    },
  }),

  createModuleTest({
    ...base,
    name: 'Old bans outside banRecentDays and hidden values never flag',
    userConfig: {
      steamApiKey: KEY,
      minSteamLevel: 5,
      minGameHours: 10,
      appId: 251570,
      banRecentDays: 365,
    },
    setup: () =>
      fakeSteam(
        steamReplies({
          createdDaysAgo: null,
          level: null,
          games: null,
          vac: 2,
          daysSinceLastBan: 900,
        }),
      ),
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(adminPms(this)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    ...base,
    name: 'Family sharing flags with a kick; app ID comes from the game type when unset',
    userConfig: {
      steamApiKey: KEY,
      flagFamilySharing: true,
      familyAction: 'kick',
    },
    setup: function () {
      fakeSteam(steamReplies({ lender: '76561198000000999' }));
      this.client.stubs.gameserver.gameServerControllerGetOne?.callsFake(
        async () =>
          ({
            data: { data: { id: this.gameServerId, type: 'RUST' }, meta: {} },
          }) as never,
      );
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(
        requests.some(
          (r) => r.startsWith('/IPlayerService/IsPlayingSharedGame/v1/') && r.includes('appid_playing=252490'),
        ),
      ).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerKickPlayer).to.have.been.calledOnce;
      expect(adminPms(this)[0]).to.contain('game borrowed via family sharing from 76561198000000999. Action: kicked.');
    },
  }),

  createModuleTest({
    ...base,
    name: 'Without an API key it falls back to the Steam data Takaro stores',
    userConfig: {},
    setup: function () {
      fakeSteam({});
      Object.assign(this.player as object, {
        steamAccountCreated: new Date(NOW.getTime() - 3 * DAY * 1000).toISOString(),
        steamLevel: 0,
        steamNumberOfVACBans: 0,
        steamsDaysSinceLastBan: 0,
      });
    },
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(requests).to.deep.equal([]);
      expect(adminPms(this)).to.deep.equal([
        `[Steam guard] Newbie (${STEAM_ID}): FLAGGED: account 3 days old (min 30). Action: alert only.`,
      ]);
    },
  }),

  createModuleTest({
    ...base,
    name: 'Steam refusing the key logs and does nothing (no alert, no action)',
    userConfig: { steamApiKey: 'bad' },
    setup: () =>
      fakeSteam({
        '/ISteamUser/GetPlayerSummaries/v2/': {
          status: 403,
          body: 'Forbidden',
        },
      }),
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(adminPms(this)).to.deep.equal([]);
      expect(JSON.stringify(result.logs)).to.contain('Steam refused the API key');
    },
  }),

  createModuleTest({
    ...base,
    name: 'Steam API blocked by the egress allowlist: falls back to Takaro data, sgcheck says why',
    permissions: [{ permission: 'STEAM_GUARD_MANAGE' }],
    otherPlayers: [ADMIN, { name: 'Suspect', gameId: 'suspect-game', steamId: '76561198000000002', permissions: [] }],
    userConfig: { steamApiKey: KEY, minSteamLevel: 25 },
    setup: function () {
      axios.defaults.adapter = async () => {
        throw new Error(
          'Host "api.steampowered.com" is not allowed from Modules. Ask an operator to add it to the Takaro egress allowlist.',
        );
      };
      Object.assign(this.otherPlayers[1].player as object, {
        steamAccountCreated: '2008-08-24T17:05:33.000Z',
        steamLevel: 20,
      });
    },
    test: async function () {
      const suspect = this.otherPlayers[1].pog;
      const result = await this.runCommand('sgcheck', { player: suspect });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()[0]).to.equal(
        '[Steam guard] Suspect (76561198000000002): 17y old, level 20, bans ?, Takaro data - FLAGGED: Steam level 20 (min 25)',
      );
      expect(this.pms()[1]).to.contain('blocks api.steampowered.com for modules (egress allowlist)');
    },
  }),

  createModuleTest({
    ...base,
    name: 'Players without a Steam ID are skipped cleanly',
    player: { name: 'Crafter' },
    userConfig: { steamApiKey: KEY },
    setup: () => fakeSteam(steamReplies({ createdDaysAgo: 1 })),
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(requests).to.deep.equal([]);
      expect(JSON.stringify(result.logs)).to.contain('has no Steam ID');
    },
  }),

  createModuleTest({
    ...base,
    name: 'The exempt permission skips the check',
    permissions: [{ permission: 'STEAM_GUARD_EXEMPT' }],
    userConfig: { steamApiKey: KEY },
    setup: () => fakeSteam(steamReplies({ createdDaysAgo: 1 })),
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(requests).to.deep.equal([]);
      expect(JSON.stringify(result.logs)).to.contain('has the exempt permission');
    },
  }),

  createModuleTest({
    ...base,
    name: 'Whitelisted Steam ID is skipped',
    userConfig: { steamApiKey: KEY, whitelist: [STEAM_ID] },
    setup: () => fakeSteam(steamReplies({ createdDaysAgo: 1 })),
    test: async function () {
      const result = await this.runHook(HOOK);
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(requests).to.deep.equal([]);
      expect(adminPms(this)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    ...base,
    name: 'checkMode once: a player checked before is not checked again',
    userConfig: { steamApiKey: KEY, checkMode: 'once' },
    setup: () => fakeSteam(steamReplies({ createdDaysAgo: 1 })),
    test: async function () {
      await this.runHook(HOOK);
      expect(adminPms(this)).to.have.length(1);
      requests = [];
      // Even with the cache gone, a second join is skipped.
      for (const row of this.variables.all.filter((v) => v.key === 'spg:profile')) {
        await this.client.asClient.variable.variableControllerDelete(row.id);
      }
      const again = await this.runHook(HOOK);
      expect(again.success, JSON.stringify(again.logs)).to.be.true;
      expect(requests).to.deep.equal([]);
      expect(adminPms(this)).to.have.length(1);
    },
  }),

  createModuleTest({
    ...base,
    name: 'sgallow, then the join hook skips; sgunallow undoes it',
    permissions: [{ permission: 'STEAM_GUARD_MANAGE' }],
    userConfig: { steamApiKey: KEY },
    setup: () => fakeSteam(steamReplies({ createdDaysAgo: 1 })),
    test: async function () {
      const target = this.pog;
      const allow = await this.runCommand('sgallow', { player: target });
      expect(allow.success, JSON.stringify(allow.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        '[Steam guard] Newbie is allowed: their Steam profile is no longer checked on join. Undo with /sgunallow Newbie.',
      ]);
      await this.runHook(HOOK);
      expect(requests).to.deep.equal([]);
      const unallow = await this.runCommand('sgunallow', { player: target });
      expect(unallow.success, JSON.stringify(unallow.logs)).to.be.true;
      await this.runHook(HOOK);
      expect(requests.length).to.be.greaterThan(0);
    },
  }),

  createModuleTest({
    ...base,
    name: 'sgcheck shows a fresh profile and the verdict without acting',
    permissions: [{ permission: 'STEAM_GUARD_MANAGE' }],
    userConfig: { steamApiKey: KEY, minSteamLevel: 5, accountAgeAction: 'ban' },
    otherPlayers: [
      ADMIN,
      {
        name: 'Suspect',
        gameId: 'suspect-game',
        steamId: '76561198000000002',
        permissions: [],
      },
    ],
    setup: () => fakeSteam(steamReplies({ createdDaysAgo: 2, level: 3 })),
    test: async function () {
      const suspect = this.otherPlayers[1].pog;
      const result = await this.runCommand('sgcheck', { player: suspect });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        '[Steam guard] Suspect (76561198000000002): public, 2d old, level 3, 0 bans - FLAGGED: account 2 days old (min 30); Steam level 3 (min 5)',
      ]);
      expect(this.client.stubs.player.banControllerCreate).to.not.have.been.called;
      expect(adminPms(this)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    ...base,
    name: 'Commands need the manage permission',
    userConfig: { steamApiKey: KEY },
    test: async function () {
      const result = await this.runCommand('sgtest');
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You do not have permission to use sgtest.');
    },
  }),

  createModuleTest({
    ...base,
    name: 'sgtest reports reachability and a working key',
    permissions: [{ permission: 'STEAM_GUARD_MANAGE' }],
    userConfig: { steamApiKey: KEY },
    setup: () => fakeSteam(steamReplies({})),
    test: async function () {
      const result = await this.runCommand('sgtest');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        '[Steam guard] Steam API reachable (server time Thu Jan  1 00:00:00 2026). API key works.',
      ]);
    },
  }),

  createModuleTest({
    ...base,
    name: 'sgtest without a key says what is missing',
    permissions: [{ permission: 'STEAM_GUARD_MANAGE' }],
    setup: () => fakeSteam(steamReplies({})),
    test: async function () {
      const result = await this.runCommand('sgtest');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()[0]).to.contain('No steamApiKey set');
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
