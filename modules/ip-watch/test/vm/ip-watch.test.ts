import { expect } from '../../../../test/support/expect.ts';
import { describe, after } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createModuleTest, paginated, single } from '@takaro/module-test';
import type { ModuleTest, PermissionFixture } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const NEW_IP = '203.0.113.7';
const NO_PERMISSIONS: PermissionFixture = [];
const ADMIN = { name: 'AdminAnna', gameId: 'admin-1', online: true, permissions: [{ permission: 'IP_WATCH_ALERTS' }] };
const MANAGER: PermissionFixture = [{ permission: 'IP_WATCH_MANAGE' }];

function ipDetected(ip: string, country = 'DE') {
  return { ip, country, city: 'Somewhere', latitude: '0', longitude: '0' };
}

/**
 * The fake refuses `search.ip` and `extend` on the POG search, so model Takaro's behaviour here:
 * `search.ip` is a partial (ILIKE) match across the domain, `extend: ['player']` adds `player`,
 * and the online-players query is answered from the fixtures.
 */
function stubPogSearch(test: ModuleTest) {
  const all = [{ player: test.player, pog: test.pog }, ...test.otherPlayers];
  test.client.stubs.playerOnGameserver.playerOnGameServerControllerSearch?.callsFake(async (query: any) => {
    const ipSearch: string[] | undefined = query?.search?.ip;
    if (ipSearch && ipSearch.length > 0) {
      const rows = all
        .filter(({ pog }) => typeof pog.ip === 'string' && ipSearch.some((ip) => pog.ip!.includes(ip)))
        .map(({ pog, player }) => ({ ...pog, player }));
      return paginated(rows);
    }
    const onlineOnly = query?.filters?.online?.includes(true);
    return paginated(all.map(({ pog }) => pog).filter((pog) => !onlineOnly || pog.online));
  });
}

function adminPms(test: ModuleTest): string[] {
  return test.client.pmsTo(ADMIN.gameId);
}

function expectNoAction(test: ModuleTest) {
  expect(test.client.stubs.gameserver.gameServerControllerKickPlayer).to.not.have.been.called;
  expect(test.client.stubs.player.banControllerCreate).to.not.have.been.called;
}

// ── A tiny local "VPN API" so the real axios path runs without leaving the machine ──
const vpnRequests: string[] = [];
let vpnReply: { status: number; body: unknown } = { status: 200, body: {} };
const vpnServer = http.createServer((req, res) => {
  vpnRequests.push(req.url ?? '');
  res.writeHead(vpnReply.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(vpnReply.body));
});
await new Promise<void>((resolve) => vpnServer.listen(0, '127.0.0.1', resolve));
const vpnBase = `http://127.0.0.1:${(vpnServer.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((resolve) => vpnServer.close(() => resolve()));
});

describe('ip-watch (module-VM)', () => {
  describe('new-ip hook', () => {
    createModuleTest({
      name: 'clean new IP: no alert, no action, remembers IP and country',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      player: { name: 'Neo', ip: NEW_IP },
      otherPlayers: [ADMIN],
      setup: function () {
        stubPogSearch(this);
      },
      test: async function () {
        const result = await this.runHook('new-ip', { eventData: ipDetected(NEW_IP) });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(adminPms(this)).to.deep.equal([]);
        expect(this.pms()).to.deep.equal([]);
        expectNoAction(this);
        const keys = this.variables.all.map((row) => row.key).sort();
        expect(keys).to.deep.equal(['ipw_ip:203.0.113.7', 'ipw_last_country']);
        const country = this.variables.all.find((row) => row.key === 'ipw_last_country')!;
        expect(country.playerId).to.equal(this.player.id);
        expect(JSON.parse(country.value)).to.equal('DE');
      },
    }).run();

    createModuleTest({
      name: 'shared IP: online admin with IP_WATCH_ALERTS gets a PM with a masked IP, player gets nothing',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      player: { name: 'Neo', ip: NEW_IP },
      otherPlayers: [ADMIN, { name: 'AltBob', gameId: 'bob-1', ip: NEW_IP, online: false }],
      setup: function () {
        stubPogSearch(this);
      },
      test: async function () {
        const result = await this.runHook('new-ip', { eventData: ipDetected(NEW_IP) });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(adminPms(this)).to.deep.equal(['[IP Watch] Neo: shares IP 203.0.x.x with AltBob']);
        expect(this.pms()).to.deep.equal([]);
        expect(this.client.pmsTo('bob-1')).to.deep.equal([]);
        expect(adminPms(this).join(' ')).to.not.include(NEW_IP);
        expectNoAction(this);
      },
    }).run();

    createModuleTest({
      name: 'shared IP is found through the module index of earlier sightings',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      player: { name: 'Neo' },
      otherPlayers: [ADMIN],
      setup: function () {
        stubPogSearch(this);
        this.variables.insert({
          key: `ipw_ip:${NEW_IP}`,
          value: JSON.stringify([{ id: 'old-player-id', name: 'OldAlt' }]),
          moduleId: this.moduleId,
        });
      },
      test: async function () {
        const result = await this.runHook('new-ip', { eventData: ipDetected(NEW_IP) });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(adminPms(this)).to.deep.equal(['[IP Watch] Neo: shares IP 203.0.x.x with OldAlt']);
        const index = this.variables.all.find((row) => row.key === `ipw_ip:${NEW_IP}`)!;
        expect(JSON.parse(index.value).map((e: { name: string }) => e.name)).to.deep.equal(['Neo', 'OldAlt']);
      },
    }).run();

    createModuleTest({
      name: 'partial IP matches (203.0.113.70 vs 203.0.113.7) do not count as shared',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      player: { name: 'Neo', ip: NEW_IP },
      otherPlayers: [ADMIN, { name: 'Stranger', ip: '203.0.113.70' }],
      setup: function () {
        stubPogSearch(this);
      },
      test: async function () {
        const result = await this.runHook('new-ip', { eventData: ipDetected(NEW_IP) });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(adminPms(this)).to.deep.equal([]);
      },
    }).run();

    createModuleTest({
      name: 'country change with countryChangeAction=ban bans the player and says so in the alert',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      player: { name: 'Neo' },
      otherPlayers: [ADMIN],
      userConfig: { countryChangeAction: 'ban', kickBanReason: 'Flagged', banDuration: 3600000 },
      now: new Date('2026-11-05T12:00:00.000Z'),
      setup: function () {
        stubPogSearch(this);
        this.variables.insert({
          key: 'ipw_last_country',
          value: JSON.stringify('NL'),
          moduleId: this.moduleId,
          playerId: this.player.id,
        });
      },
      test: async function () {
        const result = await this.runHook('new-ip', { eventData: ipDetected(NEW_IP, 'BR') });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(adminPms(this)).to.deep.equal(['[IP Watch] Neo: country changed NL -> BR -> banned']);
        const ban = this.client.stubs.player.banControllerCreate!;
        expect(ban).to.have.been.calledOnce;
        const input = ban.firstCall.args[0] as { playerId: string; reason: string; until: string | Date };
        expect(input.playerId).to.equal(this.player.id);
        expect(input.reason).to.equal('Flagged');
        expect(new Date(input.until).toISOString()).to.equal('2026-11-05T13:00:00.000Z');
        const country = this.variables.all.find((row) => row.key === 'ipw_last_country')!;
        expect(JSON.parse(country.value)).to.equal('BR');
      },
    }).run();

    createModuleTest({
      name: 'country change falls back to Takaro IP history when the module has no record yet',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      player: { name: 'Neo' },
      otherPlayers: [ADMIN],
      setup: function () {
        stubPogSearch(this);
        const player = this.player;
        this.client.stubs.player.playerControllerGetOne?.callsFake(async () =>
          single({
            ...player,
            ipHistory: [
              { ip: NEW_IP, country: 'BR', createdAt: '2026-11-05T10:00:00.000Z' },
              { ip: '198.51.100.1', country: 'NL', createdAt: '2026-11-01T10:00:00.000Z' },
            ],
          }),
        );
      },
      test: async function () {
        const result = await this.runHook('new-ip', { eventData: ipDetected(NEW_IP, 'BR') });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(adminPms(this)).to.deep.equal(['[IP Watch] Neo: country changed NL -> BR']);
        expectNoAction(this);
      },
    }).run();

    createModuleTest({
      name: 'IP_WATCH_EXEMPT: no alert and no action even with kick configured',
      module: MODULE,
      permissions: [{ permission: 'IP_WATCH_EXEMPT' }],
      player: { name: 'Neo', ip: NEW_IP },
      otherPlayers: [ADMIN, { name: 'AltBob', ip: NEW_IP }],
      userConfig: { sharedIpAction: 'kick' },
      setup: function () {
        stubPogSearch(this);
      },
      test: async function () {
        const result = await this.runHook('new-ip', { eventData: ipDetected(NEW_IP) });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(adminPms(this)).to.deep.equal([]);
        expectNoAction(this);
      },
    }).run();

    createModuleTest({
      name: 'whitelist by name: no alert and no action',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      player: { name: 'Neo', ip: NEW_IP },
      otherPlayers: [ADMIN, { name: 'AltBob', ip: NEW_IP }],
      userConfig: { whitelist: ['neo'], sharedIpAction: 'ban' },
      setup: function () {
        stubPogSearch(this);
      },
      test: async function () {
        const result = await this.runHook('new-ip', { eventData: ipDetected(NEW_IP) });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(adminPms(this)).to.deep.equal([]);
        expectNoAction(this);
      },
    }).run();

    createModuleTest({
      name: 'VPN check is off by default: the API is never called',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      player: { name: 'Neo' },
      otherPlayers: [ADMIN],
      setup: function () {
        stubPogSearch(this);
        vpnRequests.length = 0;
      },
      test: async function () {
        const result = await this.runHook('new-ip', { eventData: ipDetected(NEW_IP) });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(vpnRequests).to.deep.equal([]);
      },
    }).run();

    createModuleTest({
      name: 'VPN detected (proxycheck format) with vpnAction=kick: kicks and alerts admins and Discord',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      player: { name: 'Neo' },
      otherPlayers: [ADMIN],
      userConfig: {
        discordChannelId: '123456789',
        vpnCheck: true,
        vpnApiKey: 'secret key',
        vpnApiUrl: `${vpnBase}/v2/{ip}?vpn=1&key={key}`,
        vpnAction: 'kick',
      },
      setup: function () {
        stubPogSearch(this);
        vpnRequests.length = 0;
        vpnReply = { status: 200, body: { status: 'ok', [NEW_IP]: { proxy: 'yes', type: 'VPN', risk: 66 } } };
      },
      test: async function () {
        const result = await this.runHook('new-ip', { eventData: ipDetected(NEW_IP) });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(vpnRequests).to.deep.equal(['/v2/203.0.113.7?vpn=1&key=secret%20key']);
        const alert = '[IP Watch] Neo: VPN/proxy detected (VPN, risk 66) -> kicked';
        expect(adminPms(this)).to.deep.equal([alert]);
        expect(this.client.stubs.gameserver.gameServerControllerKickPlayer).to.have.been.calledOnceWith(
          this.gameServerId,
          this.player.id,
        );
        expect(this.client.stubs.discord.discordControllerSendMessage).to.have.been.calledOnceWith('123456789', {
          message: alert,
        });
      },
    }).run();

    createModuleTest({
      name: 'VPN API error: logged, no alert, no action, hook still succeeds',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      player: { name: 'Neo' },
      otherPlayers: [ADMIN],
      userConfig: { vpnCheck: true, vpnApiKey: 'k', vpnApiUrl: `${vpnBase}/v2/{ip}?key={key}`, vpnAction: 'ban' },
      setup: function () {
        stubPogSearch(this);
        vpnReply = { status: 500, body: { error: 'down' } };
      },
      test: async function () {
        const result = await this.runHook('new-ip', { eventData: ipDetected(NEW_IP) });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(result.logs.map((l) => l.msg).join('\n')).to.include('VPN lookup failed');
        expect(adminPms(this)).to.deep.equal([]);
        expectNoAction(this);
      },
    }).run();

    createModuleTest({
      name: 'ipapi provider: hosting=true counts as flagged',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      player: { name: 'Neo' },
      otherPlayers: [ADMIN],
      userConfig: { vpnCheck: true, vpnProvider: 'ipapi', vpnApiUrl: `${vpnBase}/json/{ip}` },
      setup: function () {
        stubPogSearch(this);
        vpnReply = { status: 200, body: { status: 'success', proxy: false, hosting: true } };
      },
      test: async function () {
        const result = await this.runHook('new-ip', { eventData: ipDetected(NEW_IP) });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(adminPms(this)).to.deep.equal(['[IP Watch] Neo: VPN/proxy detected (hosting)']);
        expectNoAction(this);
      },
    }).run();

    createModuleTest({
      name: 'showFullIp=true puts the full IP in the alert',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      player: { name: 'Neo', ip: NEW_IP },
      otherPlayers: [ADMIN, { name: 'AltBob', ip: NEW_IP }],
      userConfig: { showFullIp: true },
      setup: function () {
        stubPogSearch(this);
      },
      test: async function () {
        const result = await this.runHook('new-ip', { eventData: ipDetected(NEW_IP) });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(adminPms(this)).to.deep.equal(['[IP Watch] Neo: shares IP 203.0.113.7 with AltBob']);
      },
    }).run();
  });

  describe('identity-conflict hook', () => {
    createModuleTest({
      name: 'alerts admins with the other matched player names',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      player: { name: 'Neo' },
      otherPlayers: [ADMIN, { name: 'SteamTwin' }],
      setup: function () {
        stubPogSearch(this);
      },
      test: async function () {
        const twin = this.otherPlayers[1]!.player;
        const result = await this.runHook('identity-conflict', {
          eventData: {
            keptPlayerId: this.player.id,
            steamId: '76561198000000000',
            matchedPlayers: [
              { playerId: this.player.id, matchedOn: ['epicOnlineServicesId'] },
              { playerId: twin.id, matchedOn: ['steamId'] },
            ],
          },
        });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(adminPms(this)).to.deep.equal([
          '[IP Watch] Identity conflict: Neo also matches SteamTwin (on steamId). Possible alt or shared account.',
        ]);
      },
    }).run();

    createModuleTest({
      name: 'identityConflictAlert=false: silent',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      otherPlayers: [ADMIN],
      userConfig: { identityConflictAlert: false },
      setup: function () {
        stubPogSearch(this);
      },
      test: async function () {
        const result = await this.runHook('identity-conflict', { eventData: { matchedPlayers: [] } });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(adminPms(this)).to.deep.equal([]);
      },
    }).run();
  });

  describe('new-name hook', () => {
    createModuleTest({
      name: 'off by default',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      otherPlayers: [ADMIN],
      setup: function () {
        stubPogSearch(this);
      },
      test: async function () {
        const result = await this.runHook('new-name', { eventData: { oldName: 'Old', newName: 'New' } });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(adminPms(this)).to.deep.equal([]);
      },
    }).run();

    createModuleTest({
      name: 'nameChangeAlert=true: alerts admins',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      otherPlayers: [ADMIN],
      userConfig: { nameChangeAlert: true },
      setup: function () {
        stubPogSearch(this);
      },
      test: async function () {
        const result = await this.runHook('new-name', { eventData: { oldName: 'Old', newName: 'New' } });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(adminPms(this)).to.deep.equal(['[IP Watch] Name change: Old -> New']);
      },
    }).run();
  });

  describe('ipcheck command', () => {
    createModuleTest({
      name: 'without IP_WATCH_MANAGE: refused',
      module: MODULE,
      permissions: NO_PERMISSIONS,
      otherPlayers: [{ name: 'Target' }],
      test: async function () {
        const result = await this.runCommand('ipcheck', { player: this.otherPlayers[0]!.pog });

        expect(result.success).to.be.false;
        expect(this.userError(result)).to.equal('You do not have permission to use ipcheck.');
        expect(this.client.stubs.player.playerControllerGetOne).to.not.have.been.called;
      },
    }).run();

    createModuleTest({
      name: 'with IP_WATCH_MANAGE: shows IP count, masked latest IP, shared-with list and last country',
      module: MODULE,
      permissions: MANAGER,
      player: { name: 'AdminAnna' },
      otherPlayers: [
        { name: 'Target', ip: NEW_IP },
        { name: 'AltBob', ip: NEW_IP },
      ],
      setup: function () {
        stubPogSearch(this);
        const target = this.otherPlayers[0]!.player;
        this.client.stubs.player.playerControllerGetOne?.callsFake(async () =>
          single({
            ...target,
            ipHistory: [
              { ip: '198.51.100.1', country: 'NL', createdAt: '2026-11-01T10:00:00.000Z' },
              { ip: NEW_IP, country: 'DE', createdAt: '2026-11-05T10:00:00.000Z' },
              { ip: NEW_IP, country: 'DE', createdAt: '2026-11-04T10:00:00.000Z' },
            ],
          }),
        );
      },
      test: async function () {
        const result = await this.runCommand('ipcheck', { player: this.otherPlayers[0]!.pog });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(this.pms()).to.deep.equal([
          '[IP Watch] Target: 2 known IPs, last country DE.',
          'Latest IP: 203.0.x.x',
          'Shares IP with: AltBob (via 203.0.x.x)',
        ]);
        expect(this.pms().join(' ')).to.not.include(NEW_IP);
      },
    }).run();

    createModuleTest({
      name: 'with IP_WATCH_MANAGE and no history: says so plainly',
      module: MODULE,
      permissions: MANAGER,
      otherPlayers: [{ name: 'Fresh' }],
      setup: function () {
        stubPogSearch(this);
      },
      test: async function () {
        const result = await this.runCommand('ipcheck', { player: this.otherPlayers[0]!.pog });

        expect(result.success, JSON.stringify(result.logs)).to.be.true;
        expect(this.pms()).to.deep.equal(['[IP Watch] Fresh: 0 known IPs, last country unknown.', 'Shares IP with: nobody']);
      },
    }).run();
  });
});
