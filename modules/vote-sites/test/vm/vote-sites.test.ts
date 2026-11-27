import { expect } from '../../../../test/support/expect.ts';
import { after, describe } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

// A real HTTP server speaking the server-list vote API (7daystodie-servers.com and siblings), so the
// module's own axios calls run unchanged. Each site is a path prefix; votes are keyed by steamid or username.
type Vote = 0 | 1 | 2;
interface SiteState {
  key: string;
  votes: Map<string, Vote>;
  failWith?: number;
  claimAnswer?: string;
  badKeyAnswer?: string;
}
interface Request {
  site: string;
  method: string;
  params: Record<string, string>;
}

const sites = new Map<string, SiteState>();
const requests: Request[] = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const [, siteName, api] = url.pathname.split('/');
  const params = Object.fromEntries(url.searchParams);
  requests.push({ site: siteName, method: req.method ?? '', params });
  const site = sites.get(siteName);
  if (!site || api !== 'api') {
    res.writeHead(404).end('not found');
    return;
  }
  if (site.failWith) {
    res.writeHead(site.failWith).end('Service unavailable');
    return;
  }
  if (params.key !== site.key) {
    res.writeHead(200).end(site.badKeyAnswer ?? 'Error: server key not found');
    return;
  }
  const voter = params.steamid ?? params.username ?? '';
  const vote = site.votes.get(voter) ?? 0;
  if (params.action === 'post') {
    if (site.claimAnswer !== undefined) {
      res.writeHead(200).end(site.claimAnswer);
      return;
    }
    if (vote === 1) site.votes.set(voter, 2);
    res.writeHead(200).end(vote === 1 ? '1' : '0');
    return;
  }
  res.writeHead(200).end(String(vote));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const STEAM_ID = '76561198000000001';
const CLAIM = [{ permission: 'VOTE_SITES_CLAIM' }];

function site(name: string, votes: Record<string, Vote> = {}, extra: Partial<SiteState> = {}) {
  sites.set(name, { key: `key-${name}`, votes: new Map(Object.entries(votes)), ...extra });
  return { name, apiBase: `${BASE}/${name}`, apiKey: `key-${name}`, voteLink: `https://example.test/${name}` };
}

function requestsTo(name: string) {
  return requests.filter((r) => r.site === name);
}

const group = 'vote-sites (module-VM)';

const tests = [
  createModuleTest({
    name: 'Claims an unclaimed vote and gives currency, items and a broadcast',
    module: MODULE,
    permissions: CLAIM,
    player: { name: 'Alice', steamId: STEAM_ID },
    settings: { currencyName: 'coins' },
    userConfig: {
      sites: [site('happy', { [STEAM_ID]: 1 })],
      currency: 150,
      items: [{ item: 'item-1', amount: 2, quality: '3' }],
    },
    test: async function () {
      this.client.stubs.item.itemControllerFindOne?.resolves({
        data: { data: { id: 'item-1', name: 'Stone axe' } },
      } as never);

      const result = await this.runCommand('vote');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(requestsTo('happy').map((r) => [r.method, r.params.action ?? 'check', r.params.steamid])).to.deep.equal([
        ['GET', 'check', STEAM_ID],
        ['POST', 'post', STEAM_ID],
      ]);
      expect(this.currency.balanceOf(this.player.id)).to.equal(150);
      expect(this.client.stubs.gameserver.gameServerControllerGiveItem).to.have.been.calledOnceWith(
        this.gameServerId,
        this.player.id,
        { name: 'item-1', amount: 2, quality: '3' },
      );
      expect(this.pms()).to.deep.equal(['Thanks for voting on happy! You received 150 coins, 2x Stone axe.']);
      const broadcasts = this.messages.filter((m) => m.recipientGameId === undefined);
      expect(broadcasts.map((m) => m.message)).to.deep.equal([
        'Alice voted for the server on happy and got a reward! Type /vote to get yours.',
      ]);
    },
  }),

  createModuleTest({
    name: 'Not voted: shows the vote link and gives nothing',
    module: MODULE,
    permissions: CLAIM,
    player: { steamId: STEAM_ID },
    userConfig: { sites: [site('novote')] },
    test: async function () {
      const result = await this.runCommand('vote');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(requestsTo('novote').map((r) => r.method)).to.deep.equal(['GET']);
      expect(this.currency.balanceOf(this.player.id)).to.equal(0);
      expect(this.pms()).to.deep.equal([
        'No vote found on novote in the last 24 hours. Vote at https://example.test/novote, then type /vote.',
      ]);
    },
  }),

  createModuleTest({
    name: 'Already claimed: says so and gives nothing',
    module: MODULE,
    permissions: CLAIM,
    player: { steamId: STEAM_ID },
    userConfig: { sites: [site('claimed', { [STEAM_ID]: 2 })] },
    test: async function () {
      const result = await this.runCommand('vote');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(requestsTo('claimed').map((r) => r.method)).to.deep.equal(['GET']);
      expect(this.currency.balanceOf(this.player.id)).to.equal(0);
      expect(this.pms()).to.deep.equal([
        'You already claimed your vote reward for claimed. You can vote again 24 hours after your last vote.',
      ]);
    },
  }),

  createModuleTest({
    name: 'A claim that loses the race (site answers 0) gives no reward',
    module: MODULE,
    permissions: CLAIM,
    player: { steamId: STEAM_ID },
    userConfig: { sites: [site('race', { [STEAM_ID]: 1 }, { claimAnswer: '0' })] },
    test: async function () {
      const result = await this.runCommand('vote');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.player.id)).to.equal(0);
      expect(this.pms()[0]).to.match(/already claimed your vote reward for race/);
    },
  }),

  createModuleTest({
    name: 'Site down: friendly message, no claim, no reward',
    module: MODULE,
    permissions: CLAIM,
    player: { steamId: STEAM_ID },
    userConfig: { sites: [site('down', { [STEAM_ID]: 1 }, { failWith: 503 })] },
    test: async function () {
      const result = await this.runCommand('vote');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(requestsTo('down').map((r) => r.method)).to.deep.equal(['GET']);
      expect(this.currency.balanceOf(this.player.id)).to.equal(0);
      expect(this.pms()).to.deep.equal([
        'down is not responding right now. Your vote is safe, try again in a few minutes.',
      ]);
    },
  }),

  createModuleTest({
    name: 'Wrong server key: asks the player to tell an admin',
    module: MODULE,
    permissions: CLAIM,
    player: { steamId: STEAM_ID },
    userConfig: { sites: [{ ...site('badkey', { [STEAM_ID]: 1 }), apiKey: 'wrong' }] },
    test: async function () {
      const result = await this.runCommand('vote');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.player.id)).to.equal(0);
      expect(this.pms()).to.deep.equal(['The vote key for badkey is not set up correctly. Please tell an admin.']);
    },
  }),

  createModuleTest({
    name: 'Wrong key, 7daystodie-servers.com wording ("invalid server key"), counts as a bad key',
    module: MODULE,
    permissions: CLAIM,
    player: { steamId: STEAM_ID },
    userConfig: {
      sites: [{ ...site('badkey2', {}, { badKeyAnswer: 'Error: invalid server key' }), apiKey: 'wrong' }],
    },
    test: async function () {
      const result = await this.runCommand('vote');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['The vote key for badkey2 is not set up correctly. Please tell an admin.']);
    },
  }),

  createModuleTest({
    name: 'Two sites: rewards the voted one and does not nag about the other',
    module: MODULE,
    permissions: CLAIM,
    player: { steamId: STEAM_ID },
    settings: { currencyName: 'coins' },
    userConfig: {
      sites: [site('first'), site('second', { [STEAM_ID]: 1 })],
      currency: 50,
      broadcastMessage: '',
    },
    test: async function () {
      const result = await this.runCommand('vote');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.player.id)).to.equal(50);
      expect(this.pms()).to.deep.equal(['Thanks for voting on second! You received 50 coins.']);
    },
  }),

  createModuleTest({
    name: 'Reward that fails after the claim is saved as pending, with its progress',
    module: MODULE,
    permissions: CLAIM,
    player: { steamId: STEAM_ID },
    settings: { currencyName: 'coins' },
    userConfig: {
      sites: [site('givefail', { [STEAM_ID]: 1 })],
      currency: 40,
      items: [{ item: 'item-1', amount: 1 }],
    },
    test: async function () {
      this.client.stubs.item.itemControllerFindOne?.resolves({ data: { data: { id: 'item-1', name: 'Axe' } } } as never);
      this.client.stubs.gameserver.gameServerControllerGiveItem?.rejects(new Error('Player is offline'));

      const result = await this.runCommand('vote');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.player.id)).to.equal(40);
      expect(this.pms()).to.deep.equal([
        'Your reward for voting on givefail could not be given right now. It is saved, type the vote command again later.',
      ]);
      expect(this.messages.filter((m) => m.recipientGameId === undefined)).to.have.length(0);
      const pending = this.variables.all.filter((row) => row.key.startsWith('vote_sites_pending:'));
      expect(pending).to.have.length(1);
      expect(JSON.parse(pending[0].value)).to.deep.equal({ site: 'givefail', currencyDone: true, itemsDone: 0 });
      expect(pending[0].playerId).to.equal(this.player.id);
      expect(pending[0].gameServerId).to.equal(this.gameServerId);
    },
  }),

  createModuleTest({
    name: 'A pending reward is paid on the next vote, without paying the currency twice',
    module: MODULE,
    permissions: CLAIM,
    player: { steamId: STEAM_ID },
    settings: { currencyName: 'coins' },
    userConfig: {
      sites: [site('retry', { [STEAM_ID]: 2 })],
      currency: 40,
      items: [{ item: 'item-1', amount: 1 }],
      broadcastMessage: '',
    },
    test: async function () {
      this.client.stubs.item.itemControllerFindOne?.resolves({ data: { data: { id: 'item-1', name: 'Axe' } } } as never);
      this.client.stubs.gameserver.gameServerControllerGiveItem?.onFirstCall().rejects(new Error('Player is offline'));

      sites.get('retry')!.votes.set(STEAM_ID, 1);
      await this.runCommand('vote');
      expect(this.currency.balanceOf(this.player.id)).to.equal(40);

      const second = await this.runCommand('vote');

      expect(second.success, JSON.stringify(second.logs)).to.be.true;
      expect(this.currency.balanceOf(this.player.id)).to.equal(40);
      expect(this.client.stubs.gameserver.gameServerControllerGiveItem).to.have.been.calledTwice;
      expect(this.pms().slice(1)).to.deep.equal([
        'Thanks for voting on retry! You received 40 coins, 1x Axe.',
        'You already claimed your vote reward for retry. You can vote again 24 hours after your last vote.',
      ]);
      expect(this.variables.all.filter((row) => row.key.startsWith('vote_sites_pending:'))).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'A pending entry taken by another run is skipped (no double pay)',
    module: MODULE,
    permissions: CLAIM,
    player: { steamId: STEAM_ID },
    userConfig: { sites: [site('taken', { [STEAM_ID]: 2 })], currency: 25, broadcastMessage: '' },
    test: async function () {
      await this.variables.create({
        key: 'vote_sites_pending:1-a',
        value: JSON.stringify({ site: 'taken', currencyDone: false, itemsDone: 0 }),
        gameServerId: this.gameServerId,
        playerId: this.player.id,
        moduleId: this.moduleId,
      });
      this.client.stubs.variable.variableControllerDelete?.rejects(new Error('Request failed with status code 404'));

      const result = await this.runCommand('vote');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.player.id)).to.equal(0);
    },
  }),

  createModuleTest({
    name: 'Seeded pending reward is paid once even when no new vote exists',
    module: MODULE,
    permissions: CLAIM,
    player: { steamId: STEAM_ID },
    settings: { currencyName: 'coins' },
    userConfig: { sites: [site('seeded')], currency: 30, broadcastMessage: '' },
    test: async function () {
      await this.variables.create({
        key: 'vote_sites_pending:1-b',
        value: JSON.stringify({ site: 'seeded', currencyDone: false, itemsDone: 0 }),
        gameServerId: this.gameServerId,
        playerId: this.player.id,
        moduleId: this.moduleId,
      });

      await this.runCommand('vote');
      await this.runCommand('vote');

      expect(this.currency.balanceOf(this.player.id)).to.equal(30);
      expect(this.pms()).to.deep.equal([
        'Thanks for voting on seeded! You received 30 coins.',
        'No vote found on seeded in the last 24 hours. Vote at https://example.test/seeded, then type /vote.',
      ]);
    },
  }),

  createModuleTest({
    name: 'Site claim fails (POST error): friendly message, nothing queued',
    module: MODULE,
    permissions: CLAIM,
    player: { steamId: STEAM_ID },
    userConfig: { sites: [site('postfail', { [STEAM_ID]: 1 }, { claimAnswer: 'Error: database busy' })], currency: 10 },
    test: async function () {
      const result = await this.runCommand('vote');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.player.id)).to.equal(0);
      expect(this.variables.all).to.have.length(0);
      expect(this.pms()).to.deep.equal(['postfail gave an unexpected answer. Try again later or tell an admin.']);
    },
  }),

  createModuleTest({
    name: 'Unknown host (404): friendly message instead of a crash',
    module: MODULE,
    permissions: CLAIM,
    player: { steamId: STEAM_ID },
    userConfig: { sites: [{ name: 'Gone', apiBase: `${BASE}/does-not-exist`, apiKey: 'k' }] },
    test: async function () {
      const result = await this.runCommand('vote');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Gone is not responding right now. Your vote is safe, try again in a few minutes.',
      ]);
    },
  }),

  createModuleTest({
    name: 'VIP multiplier count multiplies the currency',
    module: MODULE,
    permissions: [...CLAIM, { permission: 'VOTE_SITES_MULTIPLIER', count: 3 }],
    player: { steamId: STEAM_ID },
    userConfig: { sites: [site('vip', { [STEAM_ID]: 1 })], currency: 100 },
    test: async function () {
      const result = await this.runCommand('vote');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.currency.balanceOf(this.player.id)).to.equal(300);
    },
  }),

  createModuleTest({
    name: 'Without VOTE_SITES_CLAIM the player is refused and no site is called',
    module: MODULE,
    permissions: [],
    player: { steamId: STEAM_ID },
    userConfig: { sites: [site('noperm', { [STEAM_ID]: 1 })] },
    test: async function () {
      const result = await this.runCommand('vote');

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal('You are not allowed to claim vote rewards on this server.');
      expect(requestsTo('noperm')).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'No vote sites configured: tells the player to ask an admin',
    module: MODULE,
    permissions: CLAIM,
    test: async function () {
      const result = await this.runCommand('vote');

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.match(/Voting is not set up on this server yet/);
    },
  }),

  createModuleTest({
    name: 'No Steam ID while matching by Steam ID: explains why the vote cannot be checked',
    module: MODULE,
    permissions: CLAIM,
    player: { name: 'Bob', steamId: undefined },
    userConfig: { sites: [site('nosteam', { Bob: 1 })] },
    test: async function () {
      const result = await this.runCommand('vote');

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.match(/matches votes by Steam ID and your player has none/);
      expect(requestsTo('nosteam')).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'steamIdThenUsername: a player without Steam ID is looked up by name',
    module: MODULE,
    permissions: CLAIM,
    player: { name: 'Bob', steamId: undefined },
    userConfig: { sites: [site('byname', { Bob: 1 })], identifyBy: 'steamIdThenUsername', currency: 5 },
    test: async function () {
      const result = await this.runCommand('vote');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(requestsTo('byname').map((r) => r.params.username)).to.deep.equal(['Bob', 'Bob']);
      expect(this.currency.balanceOf(this.player.id)).to.equal(5);
    },
  }),

  createModuleTest({
    name: 'username mode matches by name even when the player has a Steam ID',
    module: MODULE,
    permissions: CLAIM,
    player: { name: 'Carol', steamId: STEAM_ID },
    userConfig: { sites: [site('nameonly', { Carol: 1 })], identifyBy: 'username', currency: 7 },
    test: async function () {
      const result = await this.runCommand('vote');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(requestsTo('nameonly').map((r) => [r.params.username, r.params.steamid])).to.deep.equal([
        ['Carol', undefined],
        ['Carol', undefined],
      ]);
      expect(this.currency.balanceOf(this.player.id)).to.equal(7);
    },
  }),

  createModuleTest({
    name: 'Reminder cron job broadcasts the vote links',
    module: MODULE,
    systemConfig: { cronJobs: { 'vote-reminder': { enabled: true } } },
    userConfig: { sites: [site('remind-a'), { ...site('remind-b'), voteLink: '' }] },
    test: async function () {
      const result = await this.runCronJob('vote-reminder');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages.map((m) => m.message)).to.deep.equal([
        'Enjoying the server? Vote for us at https://example.test/remind-a, remind-b and type /vote for a reward!',
      ]);
    },
  }),

  createModuleTest({
    name: 'Reminder cron job stays quiet when no site is configured',
    module: MODULE,
    test: async function () {
      const result = await this.runCronJob('vote-reminder');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.have.length(0);
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
