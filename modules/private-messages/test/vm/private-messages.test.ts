import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, paginated } from '@takaro/module-test';
import type { ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const NOW = new Date('2026-11-05T12:00:00.000Z');
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

const K = {
  replyTo: 'pm_reply_to',
  ignore: 'pm_ignore',
  cooldown: 'pm_last_sent',
  mailbox: 'pm_mailbox',
  spy: 'pm_spy',
};

interface Mail {
  fromId: string;
  fromName: string;
  text: string;
  sentAt: string;
  read: boolean;
}

function seed(test: ModuleTest, playerId: string, key: string, value: unknown) {
  test.variables.insert({
    key,
    value: JSON.stringify(value),
    gameServerId: test.gameServerId,
    moduleId: test.moduleId,
    playerId,
  });
}

function rows(test: ModuleTest, playerId: string, key: string) {
  return test.variables.all.filter(
    (r) => r.key === key && r.playerId === playerId && r.gameServerId === test.gameServerId && r.moduleId === test.moduleId,
  );
}

function stored<T>(test: ModuleTest, playerId: string, key: string): T {
  const found = rows(test, playerId, key);
  expect(found, `variable ${key}`).to.have.length(1);
  return JSON.parse(found[0].value) as T;
}

function messagesTo(test: ModuleTest, gameId: string): string[] {
  return test.messages.filter((m) => m.recipientGameId === gameId).map((m) => m.message);
}

function mail(fromName: string, text: string, minutesAgo: number, read = false): Mail {
  return { fromId: `id-${fromName}`, fromName, text, sentAt: new Date(NOW.getTime() - minutesAgo * MIN).toISOString(), read };
}

const bob = (t: ModuleTest) => t.otherPlayers[0];

/** Takaro's partial, case-insensitive name search; the fake does not model `search`, so it is stubbed. */
function stubNameSearch(test: ModuleTest) {
  const all = [test.player, ...test.otherPlayers.map((p) => p.player)];
  test.client.stubs.player.playerControllerSearch?.callsFake(async (query) => {
    const wanted = String(query?.search?.name?.[0] ?? '').toLowerCase();
    return paginated(all.filter((p) => p.name.toLowerCase().includes(wanted)));
  });
}

const tests = [
  // ---- msg ----
  createModuleTest({
    name: 'msg: delivers the full multi-word text, confirms to the sender, sets reply target and cooldown',
    module: MODULE,
    permissions: [],
    now: NOW,
    player: { name: 'Alice' },
    otherPlayers: [{ name: 'Bob', online: true }],
    test: async function () {
      const b = bob(this);
      const result = await this.runCommand(
        'msg',
        { player: b.pog, message: 'hey' },
        { chatMessage: '/msg Bob hey, want to "trade" iron?' },
      );
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(messagesTo(this, b.pog.gameId)).to.deep.equal(['[PM from Alice] hey, want to trade iron?']);
      expect(this.pms()).to.deep.equal(['[PM to Bob] hey, want to trade iron?']);
      expect(stored(this, b.pog.playerId, K.replyTo)).to.deep.equal({ playerId: this.player.id, name: 'Alice' });
      expect(stored(this, this.player.id, K.cooldown)).to.equal(NOW.getTime());
      // No broadcast ever.
      expect(this.messages.filter((m) => m.recipientGameId === undefined)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'msg: an offline player gets nothing and the sender is pointed to mail',
    module: MODULE,
    permissions: [],
    now: NOW,
    otherPlayers: [{ name: 'Bob', online: false }],
    test: async function () {
      const result = await this.runCommand('msg', { player: bob(this).pog, message: 'hi' }, { chatMessage: '/msg Bob hi there' });
      expect(this.userError(result)).to.equal('Bob is offline. Use /mail Bob <text> to leave a message.');
      expect(this.messages).to.have.length(0);
      expect(rows(this, this.player.id, K.cooldown)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'msg: refuses messaging yourself',
    module: MODULE,
    permissions: [],
    test: async function () {
      const result = await this.runCommand('msg', { player: this.pog, message: 'hi' }, { chatMessage: '/msg me hi' });
      expect(this.userError(result)).to.equal('You cannot message yourself.');
    },
  }),

  createModuleTest({
    name: 'msg: blocked when the receiver ignores the sender',
    module: MODULE,
    permissions: [],
    now: NOW,
    player: { name: 'Alice' },
    otherPlayers: [{ name: 'Bob', online: true }],
    setup: function () {
      seed(this, bob(this).pog.playerId, K.ignore, [{ playerId: this.player.id, name: 'Alice' }]);
    },
    test: async function () {
      const result = await this.runCommand('msg', { player: bob(this).pog, message: 'hi' }, { chatMessage: '/msg Bob hi' });
      expect(this.userError(result)).to.equal('Bob is not accepting your messages.');
      expect(this.messages).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'msg: staff with PM_IGNORE_EXEMPT get through an ignore',
    module: MODULE,
    permissions: [{ permission: 'PM_IGNORE_EXEMPT' }],
    now: NOW,
    player: { name: 'Admin' },
    otherPlayers: [{ name: 'Bob', online: true }],
    setup: function () {
      seed(this, bob(this).pog.playerId, K.ignore, [{ playerId: this.player.id, name: 'Admin' }]);
    },
    test: async function () {
      const result = await this.runCommand('msg', { player: bob(this).pog, message: 'read' }, { chatMessage: '/msg Bob read the rules' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(messagesTo(this, bob(this).pog.gameId)).to.deep.equal(['[PM from Admin] read the rules']);
    },
  }),

  createModuleTest({
    name: 'msg: cooldown blocks a second message too soon, then allows it after',
    module: MODULE,
    permissions: [],
    now: NOW,
    otherPlayers: [{ name: 'Bob', online: true }],
    userConfig: { cooldownSeconds: 10 },
    setup: function () {
      seed(this, this.player.id, K.cooldown, NOW.getTime() - 4000);
    },
    test: async function () {
      const result = await this.runCommand('msg', { player: bob(this).pog, message: 'hi' }, { chatMessage: '/msg Bob hi' });
      expect(this.userError(result)).to.equal('Slow down: wait 6s before sending another message.');
      expect(this.messages).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'msg: cuts long messages to maxMessageLength',
    module: MODULE,
    permissions: [],
    now: NOW,
    player: { name: 'Alice' },
    otherPlayers: [{ name: 'Bob', online: true }],
    userConfig: { maxMessageLength: 10 },
    test: async function () {
      const result = await this.runCommand('msg', { player: bob(this).pog, message: 'a' }, { chatMessage: '/msg Bob abcdefghijklmnop' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(messagesTo(this, bob(this).pog.gameId)).to.deep.equal(['[PM from Alice] abcdefghij']);
    },
  }),

  // ---- social spy ----
  createModuleTest({
    name: 'msg: online staff with socialspy on and PM_SPY get a copy when the setting is on',
    module: MODULE,
    permissions: [],
    now: NOW,
    player: { name: 'Alice' },
    otherPlayers: [
      { name: 'Bob', online: true },
      { name: 'Mod', online: true, permissions: [{ permission: 'PM_SPY' }] },
      { name: 'ExMod', online: true, permissions: [] },
    ],
    userConfig: { socialSpy: true },
    setup: function () {
      seed(this, this.otherPlayers[1].pog.playerId, K.spy, true);
      seed(this, this.otherPlayers[2].pog.playerId, K.spy, true);
    },
    test: async function () {
      const result = await this.runCommand('msg', { player: bob(this).pog, message: 'x' }, { chatMessage: '/msg Bob secret base at 100 200' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(messagesTo(this, this.otherPlayers[1].pog.gameId)).to.deep.equal(['[Spy] Alice -> Bob: secret base at 100 200']);
      // Lost the permission: no copy even though the toggle is still stored.
      expect(messagesTo(this, this.otherPlayers[2].pog.gameId)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'msg: no spy copies while the socialSpy setting is off (default)',
    module: MODULE,
    permissions: [],
    now: NOW,
    otherPlayers: [
      { name: 'Bob', online: true },
      { name: 'Mod', online: true, permissions: [{ permission: 'PM_SPY' }] },
    ],
    setup: function () {
      seed(this, this.otherPlayers[1].pog.playerId, K.spy, true);
    },
    test: async function () {
      const result = await this.runCommand('msg', { player: bob(this).pog, message: 'x' }, { chatMessage: '/msg Bob hello' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(messagesTo(this, this.otherPlayers[1].pog.gameId)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'socialspy: refused when the setting is off',
    module: MODULE,
    permissions: [{ permission: 'PM_SPY' }],
    test: async function () {
      const result = await this.runCommand('socialspy');
      expect(this.userError(result)).to.equal('Social spy is turned off on this server.');
    },
  }),

  createModuleTest({
    name: 'socialspy: refused without PM_SPY',
    module: MODULE,
    permissions: [],
    userConfig: { socialSpy: true },
    test: async function () {
      const result = await this.runCommand('socialspy');
      expect(this.userError(result)).to.equal('You do not have permission to use social spy.');
    },
  }),

  createModuleTest({
    name: 'socialspy: toggles on and off',
    module: MODULE,
    permissions: [{ permission: 'PM_SPY' }],
    userConfig: { socialSpy: true },
    test: async function () {
      await this.runCommand('socialspy');
      expect(rows(this, this.player.id, K.spy)).to.have.length(1);
      await this.runCommand('socialspy');
      expect(rows(this, this.player.id, K.spy)).to.have.length(0);
      expect(this.pms()).to.deep.equal([
        'Social spy ON. You now see copies of private messages and mail while online.',
        'Social spy OFF. You no longer see copies of private messages.',
      ]);
    },
  }),

  // ---- r ----
  createModuleTest({
    name: 'r: tells you when nobody has messaged you yet',
    module: MODULE,
    permissions: [],
    test: async function () {
      const result = await this.runCommand('r', { message: 'hi' }, { chatMessage: '/r hi' });
      expect(this.userError(result)).to.equal('Nobody has messaged you yet. Use /msg <player> <text>.');
    },
  }),

  createModuleTest({
    name: 'r: replies to the last sender with the full text and sets their reply target',
    module: MODULE,
    permissions: [],
    now: NOW,
    player: { name: 'Alice' },
    otherPlayers: [{ name: 'Bob', online: true }],
    setup: function () {
      seed(this, this.player.id, K.replyTo, { playerId: bob(this).pog.playerId, name: 'Bob' });
    },
    test: async function () {
      const result = await this.runCommand('r', { message: 'sure' }, { chatMessage: '/r sure, meet at the trader' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(messagesTo(this, bob(this).pog.gameId)).to.deep.equal(['[PM from Alice] sure, meet at the trader']);
      expect(stored(this, bob(this).pog.playerId, K.replyTo)).to.deep.equal({ playerId: this.player.id, name: 'Alice' });
    },
  }),

  createModuleTest({
    name: 'r: last sender went offline',
    module: MODULE,
    permissions: [],
    otherPlayers: [{ name: 'Bob', online: false }],
    setup: function () {
      seed(this, this.player.id, K.replyTo, { playerId: bob(this).pog.playerId, name: 'Bob' });
    },
    test: async function () {
      const result = await this.runCommand('r', { message: 'ok' }, { chatMessage: '/r ok' });
      expect(this.userError(result)).to.equal('Bob is offline. Use /mail Bob <text> to leave a message.');
    },
  }),

  // ---- mail ----
  createModuleTest({
    name: 'mail: stores mail for an offline player',
    module: MODULE,
    permissions: [],
    now: NOW,
    player: { name: 'Alice' },
    otherPlayers: [{ name: 'Bob', online: false }],
    test: async function () {
      const result = await this.runCommand('mail', { player: bob(this).pog, message: 'x' }, { chatMessage: '/mail Bob your horse escaped' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const box = stored<Mail[]>(this, bob(this).pog.playerId, K.mailbox);
      expect(box).to.deep.equal([
        { fromId: this.player.id, fromName: 'Alice', text: 'your horse escaped', sentAt: NOW.toISOString(), read: false },
      ]);
      expect(this.pms()).to.deep.equal(['Mail sent to Bob. They will get it when they next join.']);
      expect(messagesTo(this, bob(this).pog.gameId)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'mail: an online player is told about new mail',
    module: MODULE,
    permissions: [],
    now: NOW,
    player: { name: 'Alice' },
    otherPlayers: [{ name: 'Bob', online: true }],
    test: async function () {
      const result = await this.runCommand('mail', { player: bob(this).pog, message: 'x' }, { chatMessage: '/mail Bob check this' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(messagesTo(this, bob(this).pog.gameId)).to.deep.equal(['New mail from Alice. You have 1 unread. Type /mailbox to read it.']);
      expect(this.pms()).to.deep.equal(['Mail sent to Bob. They are online and were told about it.']);
    },
  }),

  createModuleTest({
    name: 'mail: a full mailbox drops the oldest read mail',
    module: MODULE,
    permissions: [],
    now: NOW,
    player: { name: 'Alice' },
    otherPlayers: [{ name: 'Bob', online: false }],
    userConfig: { mailboxSize: 2 },
    setup: function () {
      seed(this, bob(this).pog.playerId, K.mailbox, [mail('Carl', 'old read', 60, true), mail('Dan', 'unread', 30)]);
    },
    test: async function () {
      const result = await this.runCommand('mail', { player: bob(this).pog, message: 'x' }, { chatMessage: '/mail Bob new one' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(stored<Mail[]>(this, bob(this).pog.playerId, K.mailbox).map((m) => m.text)).to.deep.equal(['unread', 'new one']);
    },
  }),

  createModuleTest({
    name: 'mail: a mailbox full of unread mail refuses new mail',
    module: MODULE,
    permissions: [],
    now: NOW,
    otherPlayers: [{ name: 'Bob', online: false }],
    userConfig: { mailboxSize: 2 },
    setup: function () {
      seed(this, bob(this).pog.playerId, K.mailbox, [mail('Carl', 'one', 60), mail('Dan', 'two', 30)]);
    },
    test: async function () {
      const result = await this.runCommand('mail', { player: bob(this).pog, message: 'x' }, { chatMessage: '/mail Bob three' });
      expect(this.userError(result)).to.equal("Bob's mailbox is full. Try again later.");
      expect(stored<Mail[]>(this, bob(this).pog.playerId, K.mailbox)).to.have.length(2);
      expect(rows(this, this.player.id, K.cooldown)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'mail: blocked by ignore',
    module: MODULE,
    permissions: [],
    player: { name: 'Alice' },
    otherPlayers: [{ name: 'Bob', online: false }],
    setup: function () {
      seed(this, bob(this).pog.playerId, K.ignore, [{ playerId: this.player.id, name: 'Alice' }]);
    },
    test: async function () {
      const result = await this.runCommand('mail', { player: bob(this).pog, message: 'x' }, { chatMessage: '/mail Bob hi' });
      expect(this.userError(result)).to.equal('Bob is not accepting your messages.');
      expect(rows(this, bob(this).pog.playerId, K.mailbox)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'mail: you can mail yourself a note',
    module: MODULE,
    permissions: [],
    now: NOW,
    player: { name: 'Alice' },
    test: async function () {
      const result = await this.runCommand('mail', { player: this.pog, message: 'x' }, { chatMessage: '/mail Alice buy nails' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(stored<Mail[]>(this, this.player.id, K.mailbox).map((m) => m.text)).to.deep.equal(['buy nails']);
    },
  }),

  // ---- hook ----
  createModuleTest({
    name: 'hook: shows unread mail on join, marks it read, stays quiet next time',
    module: MODULE,
    permissions: [],
    now: NOW,
    setup: function () {
      seed(this, this.player.id, K.mailbox, [mail('Carl', 'old', 600, true), mail('Bob', 'come to base', 90)]);
    },
    test: async function () {
      const result = await this.runHook('deliver-mail');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'You have 1 new mail:',
        'Bob (1h 30m ago): come to base',
        'Reply with /mail <player> <text>. Type /mailclear to empty your mailbox.',
      ]);
      expect(stored<Mail[]>(this, this.player.id, K.mailbox).every((m) => m.read)).to.equal(true);

      await this.runHook('deliver-mail');
      expect(this.pms()).to.have.length(3);
    },
  }),

  createModuleTest({
    name: 'hook: drops expired mail',
    module: MODULE,
    permissions: [],
    now: NOW,
    userConfig: { mailExpiryDays: 7 },
    setup: function () {
      seed(this, this.player.id, K.mailbox, [mail('Old', 'stale', (8 * DAY) / MIN)]);
    },
    test: async function () {
      const result = await this.runHook('deliver-mail');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([]);
      expect(stored<Mail[]>(this, this.player.id, K.mailbox)).to.deep.equal([]);
    },
  }),

  // ---- mailbox / mailclear ----
  createModuleTest({
    name: 'mailbox: lists all mail and marks it read',
    module: MODULE,
    permissions: [],
    now: NOW,
    setup: function () {
      seed(this, this.player.id, K.mailbox, [mail('Carl', 'old', 3 * 24 * 60, true), mail('Bob', 'new', 5)]);
    },
    test: async function () {
      const result = await this.runCommand('mailbox');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Mailbox: 2/10 mails, 1 new.',
        'Carl (3d 0h ago): old',
        '[new] Bob (5m ago): new',
        'Type /mailclear to empty your mailbox.',
      ]);
      expect(stored<Mail[]>(this, this.player.id, K.mailbox).every((m) => m.read)).to.equal(true);
    },
  }),

  createModuleTest({
    name: 'mailbox: empty',
    module: MODULE,
    permissions: [],
    test: async function () {
      await this.runCommand('mailbox');
      expect(this.pms()).to.deep.equal(['Your mailbox is empty.']);
    },
  }),

  createModuleTest({
    name: 'mailclear: deletes all mail',
    module: MODULE,
    permissions: [],
    now: NOW,
    setup: function () {
      seed(this, this.player.id, K.mailbox, [mail('Carl', 'a', 5), mail('Bob', 'b', 5)]);
    },
    test: async function () {
      await this.runCommand('mailclear');
      expect(rows(this, this.player.id, K.mailbox)).to.have.length(0);
      expect(this.pms()).to.deep.equal(['Deleted 2 mails.']);
    },
  }),

  // ---- seen ----
  createModuleTest({
    name: 'seen: online player',
    module: MODULE,
    permissions: [],
    otherPlayers: [{ name: 'Bob', online: true }],
    test: async function () {
      await this.runCommand('seen', { player: bob(this).pog });
      expect(this.pms()).to.deep.equal(['Bob is online right now.']);
    },
  }),

  createModuleTest({
    name: 'seen: offline player shows how long ago',
    module: MODULE,
    permissions: [],
    now: NOW,
    otherPlayers: [{ name: 'Bob', online: false }],
    setup: function () {
      bob(this).pog.lastSeen = new Date(NOW.getTime() - (2 * DAY + 3 * 60 * MIN)).toISOString();
    },
    test: async function () {
      await this.runCommand('seen', { player: bob(this).pog });
      expect(this.pms()).to.deep.equal(['Bob was last seen 2d 3h ago (2026-11-03 09:00 UTC).']);
    },
  }),

  // ---- ignore / unignore ----
  createModuleTest({
    name: 'ignore: adds a player by name, refuses duplicates, lists them',
    module: MODULE,
    permissions: [],
    otherPlayers: [{ name: 'Bob' }],
    setup: function () {
      stubNameSearch(this);
    },
    test: async function () {
      await this.runCommand('ignore', { player: 'bob' });
      await this.runCommand('ignore', { player: 'Bob' });
      await this.runCommand('ignore');
      expect(this.pms()).to.deep.equal([
        'You now ignore Bob. Their private messages and mail are blocked.',
        'You are already ignoring Bob.',
        'Ignored (1): Bob',
        'Use /unignore <player> to allow them again.',
      ]);
      expect(stored(this, this.player.id, K.ignore)).to.deep.equal([{ playerId: bob(this).pog.playerId, name: 'Bob' }]);
    },
  }),

  createModuleTest({
    name: 'ignore: unknown player and self',
    module: MODULE,
    permissions: [],
    player: { name: 'Alice' },
    setup: function () {
      stubNameSearch(this);
    },
    test: async function () {
      const unknown = await this.runCommand('ignore', { player: 'Zed' });
      expect(this.userError(unknown)).to.equal('No player found with the name "Zed".');
      const self = await this.runCommand('ignore', { player: 'Alice' });
      expect(this.userError(self)).to.equal('You cannot ignore yourself.');
    },
  }),

  createModuleTest({
    name: 'unignore: removes by name; unknown name errors',
    module: MODULE,
    permissions: [],
    setup: function () {
      seed(this, this.player.id, K.ignore, [
        { playerId: 'p1', name: 'Bob' },
        { playerId: 'p2', name: 'Carl' },
      ]);
    },
    test: async function () {
      await this.runCommand('unignore', { player: 'bob' });
      expect(stored(this, this.player.id, K.ignore)).to.deep.equal([{ playerId: 'p2', name: 'Carl' }]);
      const miss = await this.runCommand('unignore', { player: 'Zed' });
      expect(this.userError(miss)).to.equal('"Zed" is not on your ignore list.');
      await this.runCommand('unignore', { player: 'all' });
      expect(rows(this, this.player.id, K.ignore)).to.have.length(0);
    },
  }),
];

describe('private-messages (module-VM)', function () {
  tests.forEach((t) => {
    t.run();
  });
});
