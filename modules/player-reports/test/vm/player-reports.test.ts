import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, paginated } from '@takaro/module-test';
import type { ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const group = 'player-reports (module-VM)';

const NOW = new Date('2026-11-05T12:00:00.000Z');

const REPORTER = { name: 'Reporter', gameId: 'g-reporter', position: { x: 10.4, y: 64, z: -20.6 }, permissions: [] };
const GRIEFER = { name: 'Griefer', gameId: 'g-griefer', position: { x: 100, y: 70, z: 200 }, permissions: [] };
const STAFF = {
  name: 'Staffer',
  gameId: 'g-staff',
  permissions: [{ permission: 'REPORTS_RECEIVE' }],
};

function pmsTo(test: ModuleTest, gameId: string): string[] {
  return test.messages.filter((m) => m.recipientGameId === gameId).map((m) => m.message);
}

function rows(test: ModuleTest, key: string) {
  return test.variables.all.filter((row) => row.key === key);
}

function ticket(test: ModuleTest, id: number) {
  const row = rows(test, `pr_ticket_${id}`)[0];
  return row ? JSON.parse(row.value) : undefined;
}

function openIndex(test: ModuleTest) {
  const row = rows(test, 'pr_open')[0];
  return row ? JSON.parse(row.value) : [];
}

function stubChat(test: ModuleTest, lines: string[]) {
  // The API answers newest first; the module stores them oldest first.
  test.client.stubs.event.eventControllerSearch?.callsFake(async () =>
    paginated(
      [...lines].reverse().map((msg, i) => ({
        id: `e${i}`,
        eventName: 'chat-message',
        createdAt: new Date(NOW.getTime() - i * 1000).toISOString(),
        meta: { msg },
      })),
    ),
  );
}

function seed(test: ModuleTest, key: string, value: unknown, playerId?: string) {
  test.variables.insert({
    key,
    value: JSON.stringify(value),
    gameServerId: test.gameServerId,
    moduleId: test.moduleId,
    ...(playerId ? { playerId } : {}),
  });
}

function seedTicket(test: ModuleTest, reporterId: string, overrides: Record<string, unknown> = {}) {
  const t = {
    id: 7,
    status: 'open',
    createdAt: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(),
    reason: 'flying around my base',
    reporter: { playerId: reporterId, name: 'Reporter', position: { x: 1, y: 2, z: 3 } },
    target: { playerId: 'p-griefer', name: 'Griefer', online: true, position: { x: 100, y: 70, z: 200 } },
    chat: [{ at: NOW.toISOString(), msg: 'lol' }],
    ...overrides,
  };
  seed(test, 'pr_ticket_7', t);
  seed(test, 'pr_open', [
    { id: 7, reporterId, reporterName: 'Reporter', targetName: 'Griefer', reason: t.reason, createdAt: t.createdAt },
  ]);
  return t;
}

const tests = [
  // ---------- report ----------
  createModuleTest({
    name: 'report <player> <reason> stores a ticket with context and alerts staff',
    module: MODULE,
    now: NOW,
    permissions: [],
    player: REPORTER,
    otherPlayers: [GRIEFER, STAFF],
    setup: function () {
      stubChat(this, ['hello', 'give me your stuff', 'lol']);
    },
    test: async function () {
      const result = await this.runCommand('report', {}, { chatMessage: '/report Griefer is destroying my base' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;

      expect(this.pms()).to.deep.equal(['Report #1 about Griefer sent. Staff will look at it. Thank you!']);
      expect(pmsTo(this, 'g-staff')).to.deep.equal([
        '[Report #1] Reporter about Griefer: is destroying my base - /reportview 1',
      ]);
      expect(pmsTo(this, 'g-griefer')).to.deep.equal([]);

      const t = ticket(this, 1);
      expect(t.status).to.equal('open');
      expect(t.reason).to.equal('is destroying my base');
      expect(t.reporter).to.deep.include({ name: 'Reporter', playerId: this.player.id });
      expect(t.reporter.position).to.deep.equal({ x: 10.4, y: 64, z: -20.6 });
      expect(t.target).to.deep.include({ name: 'Griefer', online: true });
      expect(t.target.position).to.deep.equal({ x: 100, y: 70, z: 200 });
      expect(t.chat.map((c: { msg: string }) => c.msg)).to.deep.equal(['hello', 'give me your stuff', 'lol']);

      const search = this.client.stubs.event.eventControllerSearch?.firstCall.args[0] as Record<string, any>;
      expect(search.filters).to.deep.equal({
        eventName: ['chat-message'],
        playerId: [this.otherPlayers[0].player.id],
        gameserverId: [this.gameServerId],
      });
      expect(search.limit).to.equal(5);

      expect(openIndex(this)).to.have.length(1);
      expect(this.client.stubs.discord.discordControllerSendMessage).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'report matches a unique partial online name, case-insensitive',
    module: MODULE,
    now: NOW,
    permissions: [],
    player: REPORTER,
    otherPlayers: [GRIEFER],
    setup: function () {
      stubChat(this, []);
    },
    test: async function () {
      const result = await this.runCommand('report', {}, { chatMessage: '/report grief xray' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(ticket(this, 1).target.name).to.equal('Griefer');
      expect(ticket(this, 1).reason).to.equal('xray');
    },
  }),

  createModuleTest({
    name: 'report <reason> without a player name files a general report',
    module: MODULE,
    now: NOW,
    permissions: [],
    player: REPORTER,
    otherPlayers: [STAFF],
    test: async function () {
      const result = await this.runCommand('report', {}, { chatMessage: '/report stuck under the map please help' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const t = ticket(this, 1);
      expect(t.target).to.equal(null);
      expect(t.reason).to.equal('stuck under the map please help');
      expect(t.chat).to.deep.equal([]);
      expect(this.pms()).to.deep.equal(['Report #1 sent. Staff will look at it. Thank you!']);
      expect(pmsTo(this, 'g-staff')[0]).to.match(/^\[Report #1\] Reporter: stuck under the map/);
    },
  }),

  createModuleTest({
    name: 'report refuses a general report when they are turned off',
    module: MODULE,
    now: NOW,
    permissions: [],
    player: REPORTER,
    userConfig: { allowGeneralReports: false },
    test: async function () {
      const result = await this.runCommand('report', {}, { chatMessage: '/report nobody here' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.match(/Player "nobody" not found/);
      expect(rows(this, 'pr_ticket_1')).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'report asks for more of the name when it matches several players',
    module: MODULE,
    now: NOW,
    permissions: [],
    player: REPORTER,
    otherPlayers: [
      { name: 'Bobby', gameId: 'g1' },
      { name: 'Bobcat', gameId: 'g2' },
    ],
    test: async function () {
      const result = await this.runCommand('report', {}, { chatMessage: '/report bob spawn killing' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.match(/matches several players: (Bobby, Bobcat|Bobcat, Bobby)/);
    },
  }),

  createModuleTest({
    name: 'report blocks self reports and a missing reason',
    module: MODULE,
    now: NOW,
    permissions: [],
    player: REPORTER,
    otherPlayers: [GRIEFER],
    test: async function () {
      const self = await this.runCommand('report', {}, { chatMessage: '/report Reporter hacking' });
      expect(this.userError(self)).to.equal('You cannot report yourself.');

      const noReason = await this.runCommand('report', {}, { chatMessage: '/report Griefer' });
      expect(this.userError(noReason)).to.equal('Please add a reason: /report Griefer <reason>');

      const empty = await this.runCommand('report', {}, { chatMessage: '/report' });
      expect(this.userError(empty)).to.equal('Usage: /report <player> <reason> or /report <reason>');
      expect(rows(this, 'pr_ticket_1')).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'report enforces the cooldown',
    module: MODULE,
    now: NOW,
    permissions: [],
    player: REPORTER,
    userConfig: { cooldownSeconds: 60 },
    test: async function () {
      const first = await this.runCommand('report', {}, { chatMessage: '/report server is lagging' });
      expect(first.success, JSON.stringify(first.logs)).to.be.true;
      const second = await this.runCommand('report', {}, { chatMessage: '/report still lagging' });
      expect(second.success).to.be.false;
      expect(this.userError(second)).to.equal('Please wait 60s before sending another report.');
      expect(openIndex(this)).to.have.length(1);
    },
  }),

  createModuleTest({
    name: 'report enforces max open reports per player',
    module: MODULE,
    now: NOW,
    permissions: [],
    player: REPORTER,
    userConfig: { cooldownSeconds: 0, maxOpenReportsPerPlayer: 2 },
    test: async function () {
      expect((await this.runCommand('report', {}, { chatMessage: '/report one problem' })).success).to.be.true;
      expect((await this.runCommand('report', {}, { chatMessage: '/report two problem' })).success).to.be.true;
      const third = await this.runCommand('report', {}, { chatMessage: '/report three problem' });
      expect(this.userError(third)).to.match(/already have 2 open report/);
      expect(openIndex(this).map((t: { id: number }) => t.id)).to.deep.equal([1, 2]);
    },
  }),

  createModuleTest({
    name: 'report sends a Discord embed when a channel is configured',
    module: MODULE,
    now: NOW,
    permissions: [],
    player: REPORTER,
    otherPlayers: [GRIEFER],
    userConfig: { discordChannelId: '123456789' },
    setup: function () {
      stubChat(this, ['ez']);
    },
    test: async function () {
      const result = await this.runCommand('report', {}, { chatMessage: '/report Griefer duping items' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const stub = this.client.stubs.discord.discordControllerSendMessage;
      expect(stub).to.have.been.calledOnce;
      const [channel, body] = stub?.firstCall.args as [string, { embed: Record<string, any> }];
      expect(channel).to.equal('123456789');
      expect(body.embed.title).to.equal('Report #1 about Griefer');
      expect(body.embed.description).to.equal('duping items');
      expect(body.embed.fields.map((f: { name: string }) => f.name)).to.deep.equal([
        'Reporter',
        'Reported player',
        'Last 1 chat line(s) of Griefer',
      ]);
      expect(body.embed.fields[1].value).to.equal('Griefer (online @ 100, 70, 200)');
    },
  }),

  createModuleTest({
    name: 'report still succeeds when Discord and the event API fail',
    module: MODULE,
    now: NOW,
    permissions: [],
    player: REPORTER,
    otherPlayers: [GRIEFER],
    userConfig: { discordChannelId: '123' },
    setup: function () {
      this.client.stubs.event.eventControllerSearch?.rejects(new Error('403 forbidden'));
      this.client.stubs.discord.discordControllerSendMessage?.rejects(new Error('Unknown channel'));
    },
    test: async function () {
      const result = await this.runCommand('report', {}, { chatMessage: '/report Griefer xray' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(ticket(this, 1).chat).to.deep.equal([]);
      expect(this.pms()[0]).to.match(/Report #1 about Griefer sent/);
    },
  }),

  createModuleTest({
    name: 'report records an offline target without a position',
    module: MODULE,
    now: NOW,
    permissions: [],
    player: REPORTER,
    otherPlayers: [{ ...GRIEFER, online: false }],
    setup: function () {
      stubChat(this, ['bye']);
    },
    test: async function () {
      const result = await this.runCommand('report', {}, { chatMessage: '/report Griefer stole my car' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const t = ticket(this, 1);
      expect(t.target).to.deep.include({ name: 'Griefer', online: false, position: null });
      expect(t.chat.map((c: { msg: string }) => c.msg)).to.deep.equal(['bye']);
    },
  }),

  // ---------- staff commands ----------
  createModuleTest({
    name: 'staff commands are denied without REPORTS_MANAGE',
    module: MODULE,
    now: NOW,
    permissions: [{ permission: 'REPORTS_RECEIVE' }],
    test: async function () {
      for (const [cmd, args] of [
        ['reports', {}],
        ['reportview', { id: '1' }],
        ['reportclose', { id: '1' }],
      ] as const) {
        const result = await this.runCommand(cmd, args);
        expect(this.userError(result), cmd).to.equal('You do not have permission to manage reports.');
      }
    },
  }),

  createModuleTest({
    name: 'reports lists open tickets newest first',
    module: MODULE,
    now: NOW,
    permissions: [{ permission: 'REPORTS_MANAGE' }],
    setup: function () {
      seedTicket(this, 'p-reporter');
    },
    test: async function () {
      const result = await this.runCommand('reports');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Open reports: 1',
        '#7 Reporter -> Griefer: flying around my base (5m ago)',
        'Details: /reportview <id> | Close: /reportclose <id> [note]',
      ]);
    },
  }),

  createModuleTest({
    name: 'reports says when nothing is open',
    module: MODULE,
    permissions: [{ permission: 'REPORTS_MANAGE' }],
    test: async function () {
      await this.runCommand('reports');
      expect(this.pms()).to.deep.equal(['No open reports.']);
    },
  }),

  createModuleTest({
    name: 'reportview shows the ticket with positions and chat',
    module: MODULE,
    now: NOW,
    test: async function () {
      seedTicket(this, 'p-reporter');
      const result = await this.runCommand('reportview', { id: '#7' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Report #7 [OPEN] - 5m ago',
        'From: Reporter @ 1, 2, 3',
        'About: Griefer (online @ 100, 70, 200 at report time)',
        'Reason: flying around my base',
        'Last chat of Griefer:',
        '  lol',
        'Close: /reportclose 7 [note]',
      ]);

      const missing = await this.runCommand('reportview', { id: '99' });
      expect(this.userError(missing)).to.equal('Report #99 not found.');
      const bad = await this.runCommand('reportview', { id: '' });
      expect(this.userError(bad)).to.equal('Usage: /reportview <id>');
    },
  }),

  createModuleTest({
    name: 'reportclose closes, removes from the open list and PMs an online reporter',
    module: MODULE,
    now: NOW,
    player: { name: 'Admin', gameId: 'g-admin' },
    otherPlayers: [REPORTER],
    test: async function () {
      seedTicket(this, this.otherPlayers[0].player.id);
      const result = await this.runCommand('reportclose', { id: '7' }, { chatMessage: '/reportclose 7 banned him, thanks' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;

      const t = ticket(this, 7);
      expect(t).to.deep.include({ status: 'closed', closedBy: 'Admin', note: 'banned him, thanks' });
      expect(openIndex(this)).to.deep.equal([]);
      expect(pmsTo(this, 'g-reporter')).to.deep.equal(['Your report #7 was handled by staff. Note: banned him, thanks']);
      expect(this.pms()).to.deep.equal(['Report #7 closed. Reporter notified.']);

      const again = await this.runCommand('reportclose', { id: '7' });
      expect(this.userError(again)).to.equal('Report #7 is already closed.');
    },
  }),

  createModuleTest({
    name: 'reportclose queues the notice for an offline reporter; the login hook delivers it once',
    module: MODULE,
    now: NOW,
    player: { name: 'Reporter', gameId: 'g-reporter' },
    otherPlayers: [{ name: 'Admin', gameId: 'g-admin' }],
    test: async function () {
      // Ticket filed by an offline player whose id is the acting player's, closed by "someone else":
      // simulate by giving the ticket a reporter id that is not online, then re-checking via the hook.
      seedTicket(this, 'p-offline');
      const result = await this.runCommand('reportclose', { id: '7' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Report #7 closed. Reporter will be told on next login.']);
      const queued = rows(this, 'pr_notices');
      expect(queued).to.have.length(1);
      expect(queued[0].playerId).to.equal('p-offline');
      expect(JSON.parse(queued[0].value)).to.deep.equal(['Your report #7 was handled by staff.']);
    },
  }),

  createModuleTest({
    name: 'deliver-notices hook PMs queued notices on login and clears them',
    module: MODULE,
    now: NOW,
    test: async function () {
      seed(this, 'pr_notices', ['Your report #3 was handled by staff.'], this.player.id);
      const result = await this.runHook('deliver-notices', { eventType: 'player-connected', eventData: {} });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Your report #3 was handled by staff.']);
      expect(rows(this, 'pr_notices')).to.have.length(0);

      await this.runHook('deliver-notices', { eventType: 'player-connected', eventData: {} });
      expect(this.pms()).to.have.length(1);
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => test.run());
});
