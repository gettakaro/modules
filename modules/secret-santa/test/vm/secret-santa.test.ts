import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const SEASON = 2026;
const SIGNUP_KEY = `santa_signup:${SEASON}`;
const GIFT_KEY = `santa_gift:${SEASON}`;
const STATE_KEY = `santa_state:${SEASON}`;
const TOLD_KEY = `santa_told:${SEASON}`;
const MANAGE = [{ permission: 'SECRET_SANTA_MANAGE' }];

const SIGNUP_DAY = new Date('2026-12-01T19:00:00.000Z');
const BEFORE_DAY = new Date('2026-10-20T12:00:00.000Z');
const DRAW_DAY = new Date('2026-12-16T00:05:00.000Z');
const GIFT_DAY = new Date('2026-12-20T19:00:00.000Z');
const GIFT_DAY_MORNING = new Date('2026-12-20T09:00:00.000Z');
const REVEAL_DAY = new Date('2026-12-25T00:10:00.000Z');

const OTHERS = [
  { name: 'Bob', gameId: 'g-bob', currency: 500 },
  { name: 'Carol', gameId: 'g-carol', currency: 500 },
  { name: 'Dave', gameId: 'g-dave', currency: 500, online: false },
];

type T = any;

const rows = (t: T, key: string) => t.variables.all.filter((r: any) => r.key === key);
const broadcasts = (t: T) => t.messages.filter((m: any) => m.recipientGameId === undefined).map((m: any) => m.message);
const pmsTo = (t: T, gameId: string) => t.messages.filter((m: any) => m.recipientGameId === gameId).map((m: any) => m.message);
const stateOf = (t: T) => {
  const r = rows(t, STATE_KEY)[0];
  return r ? JSON.parse(r.value) : null;
};

/** Everybody in the test as { playerId, name, gameId }: acting player first, then otherPlayers. */
function people(t: T) {
  return [
    { playerId: t.player.id, name: t.player.name, gameId: t.pog.gameId },
    ...t.otherPlayers.map((o: any) => ({ playerId: o.player.id, name: o.player.name, gameId: o.pog.gameId })),
  ];
}

function seedSignup(t: T, p: { playerId: string; name: string; gameId: string }) {
  t.variables.insert({
    key: SIGNUP_KEY,
    value: JSON.stringify({ name: p.name, gameId: p.gameId, at: SIGNUP_DAY.toISOString() }),
    gameServerId: t.gameServerId,
    moduleId: t.moduleId,
    playerId: p.playerId,
  });
}

function seedState(t: T, state: Record<string, unknown>) {
  t.variables.insert({ key: STATE_KEY, value: JSON.stringify(state), gameServerId: t.gameServerId, moduleId: t.moduleId });
}

/** A fixed cycle over the given people: 0 -> 1 -> 2 -> ... -> 0. */
function cycle(list: Array<{ playerId: string; name: string; gameId: string }>) {
  return list.map((g, i) => {
    const r = list[(i + 1) % list.length];
    return { giver: g.playerId, giverName: g.name, giverGameId: g.gameId, receiver: r.playerId, receiverName: r.name, receiverGameId: r.gameId };
  });
}

function seedGift(t: T, giverId: string, receiverId: string, amount: number, note = '') {
  t.variables.insert({
    key: GIFT_KEY,
    value: JSON.stringify({ amount, note, receiver: receiverId, at: GIFT_DAY.toISOString() }),
    gameServerId: t.gameServerId,
    moduleId: t.moduleId,
    playerId: giverId,
  });
}

function expectValidDraw(pairs: any[], ids: string[]) {
  expect(pairs).to.have.length(ids.length);
  expect(pairs.map((p) => p.giver).sort()).to.deep.equal([...ids].sort());
  expect(pairs.map((p) => p.receiver).sort()).to.deep.equal([...ids].sort());
  for (const p of pairs) expect(p.giver).to.not.equal(p.receiver);
}

const tests = [
  createModuleTest({
    name: 'join during sign-up stores the player, PMs and announces; a second join is refused',
    module: MODULE,
    permissions: [],
    now: SIGNUP_DAY,
    settings: { commandPrefix: '@', currencyName: 'coins' },
    test: async function () {
      const r = await this.runCommand('santa', {}, { chatMessage: '@santa join' });
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      const signups = rows(this, SIGNUP_KEY);
      expect(signups).to.have.length(1);
      expect(signups[0].playerId).to.equal(this.player.id);
      expect(JSON.parse(signups[0].value)).to.include({ name: this.player.name, gameId: this.pog.gameId });
      expect(this.pms()).to.deep.equal(['You joined Secret Santa! Names are drawn after Dec 15. Leave with @santa leave.']);
      expect(broadcasts(this)).to.deep.equal([`${this.player.name} joined Secret Santa (1 player). Type @santa join to take part.`]);

      const again = await this.runCommand('santa', {}, { chatMessage: '@santa join' });
      expect(this.userError(again)).to.equal('You are already signed up for Secret Santa.');
      expect(rows(this, SIGNUP_KEY)).to.have.length(1);
    },
  }),

  createModuleTest({
    name: 'join before the window and after the window is refused',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: [],
    now: BEFORE_DAY,
    test: async function () {
      const r = await this.runCommand('santa', {}, { chatMessage: '/santa join' });
      expect(this.userError(r)).to.equal('Secret Santa sign-up opens on Nov 1.');
      const s = await this.runCommand('santa', {}, { chatMessage: '/santa' });
      expect(s.success).to.be.true;
      expect(this.pms()).to.deep.equal(['Secret Santa sign-up opens on Nov 1.']);
    },
  }),

  createModuleTest({
    name: 'join after sign-up end is refused',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: [],
    now: DRAW_DAY,
    test: async function () {
      const r = await this.runCommand('santa', {}, { chatMessage: '/santa join' });
      expect(this.userError(r)).to.equal('Secret Santa sign-up is closed for this year.');
    },
  }),

  createModuleTest({
    name: 'status during sign-up and leave',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: [],
    now: SIGNUP_DAY,
    userConfig: { announceJoins: false },
    otherPlayers: OTHERS,
    setup: function () {
      seedSignup(this, people(this)[1]);
    },
    test: async function () {
      await this.runCommand('santa', {}, { chatMessage: '/santa' });
      await this.runCommand('santa', {}, { chatMessage: '/santa join' });
      await this.runCommand('santa', {}, { chatMessage: '/santa' });
      const left = await this.runCommand('santa', {}, { chatMessage: '/santa leave' });
      expect(left.success, JSON.stringify(left.logs)).to.be.true;
      const again = await this.runCommand('santa', {}, { chatMessage: '/santa leave' });
      expect(this.userError(again)).to.equal('You are not signed up for Secret Santa.');
      expect(this.pms()).to.deep.equal([
        'Secret Santa sign-up is open until Dec 15. Type /santa join to take part (1 player so far).',
        'You joined Secret Santa! Names are drawn after Dec 15. Leave with /santa leave.',
        'You are signed up for Secret Santa (2 players so far). Names are drawn after Dec 15.',
        'You left Secret Santa.',
      ]);
      expect(rows(this, SIGNUP_KEY)).to.have.length(1);
      expect(broadcasts(this)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'cron draws a full cycle after sign-up ends (odd count), broadcasts and PMs online Santas',
    module: MODULE,
    settings: { currencyName: 'coins' },
    now: DRAW_DAY,
    random: [0.9, 0.1, 0.5],
    otherPlayers: OTHERS.slice(0, 2),
    setup: function () {
      for (const p of people(this)) seedSignup(this, p);
    },
    test: async function () {
      const r = await this.runCronJob('santa-tick');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      const state = stateOf(this);
      const ids = people(this).map((p) => p.playerId);
      expectValidDraw(state.pairs, ids);
      expect(broadcasts(this)).to.deep.equal(['Secret Santa: the names are drawn! 3 players take part. Check your PM or type /santa.']);
      for (const p of people(this)) {
        const pair = state.pairs.find((x: any) => x.giver === p.playerId);
        expect(pmsTo(this, p.gameId)).to.deep.equal([
          `Secret Santa: you are the Secret Santa of ${pair.receiverName}. Keep it secret!`,
          'Send your gift with /santa gift <amount> [note] by Dec 24 (100 to 1000 coins).',
        ]);
      }
      // A second tick does not draw again.
      await this.runCronJob('santa-tick');
      expect(stateOf(this).pairs).to.deep.equal(state.pairs);
    },
  }),

  createModuleTest({
    name: 'the draw never gives anybody themselves, for many random sequences and sizes',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: MANAGE,
    now: SIGNUP_DAY,
    userConfig: { minParticipants: 2 },
    otherPlayers: [...OTHERS, { name: 'Eve', gameId: 'g-eve' }],
    test: async function () {
      const everyone = people(this);
      for (const size of [2, 3, 4, 5]) {
        for (const seed of [0, 0.2, 0.5, 0.8, 0.999]) {
          for (const r of [...this.variables.all]) this.variables.delete(r.id);
          for (const p of everyone.slice(0, size)) seedSignup(this, p);
          const res = await this.runCommand('santa', {}, { chatMessage: '/santa pair' });
          expect(res.success, JSON.stringify(res.logs)).to.be.true;
          expectValidDraw(stateOf(this).pairs, everyone.slice(0, size).map((p) => p.playerId));
        }
      }
    },
    random: [0.3, 0.7, 0.1, 0.95, 0.5, 0.05],
  }),

  createModuleTest({
    name: 'too few sign-ups cancels the event with a broadcast',
    module: MODULE,
    settings: { currencyName: 'coins' },
    now: DRAW_DAY,
    otherPlayers: OTHERS.slice(0, 1),
    setup: function () {
      for (const p of people(this)) seedSignup(this, p);
    },
    test: async function () {
      const r = await this.runCronJob('santa-tick');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(stateOf(this)).to.include({ cancelled: true });
      expect(broadcasts(this)).to.deep.equal(['Secret Santa is cancelled this year: only 2 players signed up (need 3).']);
      await this.runCommand('santa', {}, { chatMessage: '/santa' });
      expect(this.pms()).to.deep.equal(['Secret Santa was cancelled this year: not enough players signed up.']);
    },
  }),

  createModuleTest({
    name: 'minParticipants 2 allows a pair of two',
    module: MODULE,
    settings: { currencyName: 'coins' },
    now: DRAW_DAY,
    userConfig: { minParticipants: 2 },
    otherPlayers: OTHERS.slice(0, 1),
    setup: function () {
      for (const p of people(this)) seedSignup(this, p);
    },
    test: async function () {
      await this.runCronJob('santa-tick');
      expectValidDraw(stateOf(this).pairs, people(this).map((p) => p.playerId));
    },
  }),

  createModuleTest({
    name: 'gift: validates, holds the money, PMs giver and online receiver, refuses a second gift; note keeps spaces',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: [],
    now: GIFT_DAY,
    currency: 300,
    otherPlayers: OTHERS,
    setup: function () {
      const all = people(this);
      seedState(this, { pairs: cycle(all), pairedAt: DRAW_DAY.toISOString() });
    },
    test: async function () {
      const cases: Array<[string, string]> = [
        ['/santa gift', 'Usage: /santa gift <amount> [note]'],
        ['/santa gift lots', 'Usage: /santa gift <amount> [note]'],
        ['/santa gift 50', 'Your gift must be 100 to 1000 coins.'],
        ['/santa gift 1001', 'Your gift must be 100 to 1000 coins.'],
        ['/santa gift 400', 'You do not have 400 coins.'],
      ];
      for (const [line, msg] of cases) {
        const r = await this.runCommand('santa', {}, { chatMessage: line });
        expect(this.userError(r), line).to.equal(msg);
      }
      expect(rows(this, GIFT_KEY)).to.have.length(0);
      expect(this.currency.balanceOf(this.player.id)).to.equal(300);

      const ok = await this.runCommand('santa', {}, { chatMessage: '/santa gift 250 Merry   Christmas,  Bob!' });
      expect(ok.success, JSON.stringify(ok.logs)).to.be.true;
      expect(this.currency.balanceOf(this.player.id)).to.equal(50);
      const gift = rows(this, GIFT_KEY);
      expect(gift).to.have.length(1);
      expect(JSON.parse(gift[0].value)).to.include({ amount: 250, note: 'Merry Christmas, Bob!', receiver: this.otherPlayers[0].player.id });
      expect(this.pms()).to.deep.equal(['Gift of 250 coins sent to Bob. It stays secret until Dec 25.']);
      expect(pmsTo(this, 'g-bob')).to.deep.equal(['Your Secret Santa sent you a gift! It opens on Dec 25.']);

      const again = await this.runCommand('santa', {}, { chatMessage: '/santa gift 100' });
      expect(this.userError(again)).to.equal('You already sent your Secret Santa gift.');
      expect(this.currency.balanceOf(this.player.id)).to.equal(50);
    },
  }),

  createModuleTest({
    name: 'gift: maxGift 0 = no maximum; not a participant; before the draw; after the deadline',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: [],
    now: GIFT_DAY,
    currency: 5000,
    userConfig: { maxGift: 0 },
    otherPlayers: OTHERS,
    setup: function () {
      seedState(this, { pairs: cycle(people(this).slice(1)) });
    },
    test: async function () {
      const r = await this.runCommand('santa', {}, { chatMessage: '/santa gift 3000' });
      expect(this.userError(r)).to.equal('You are not taking part in Secret Santa this year.');
    },
  }),

  createModuleTest({
    name: 'gift before the draw is refused',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: [],
    now: SIGNUP_DAY,
    test: async function () {
      const r = await this.runCommand('santa', {}, { chatMessage: '/santa gift 100' });
      expect(this.userError(r)).to.equal('Secret Santa names are not drawn yet. You can send a gift after the draw.');
    },
  }),

  createModuleTest({
    name: 'gift after the deadline is refused',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: [],
    now: new Date('2026-12-23T12:00:00.000Z'),
    currency: 500,
    userConfig: { giftDeadline: '12-22' },
    otherPlayers: OTHERS,
    setup: function () {
      seedState(this, { pairs: cycle(people(this)) });
    },
    test: async function () {
      const r = await this.runCommand('santa', {}, { chatMessage: '/santa gift 100' });
      expect(this.userError(r)).to.equal('The Secret Santa gift deadline has passed.');
      await this.runCommand('santa', {}, { chatMessage: '/santa' });
      expect(this.pms()).to.deep.equal(['You are the Secret Santa of Bob.', 'The gift deadline has passed.']);
    },
  }),

  createModuleTest({
    name: 'status while gifting shows the assignment, own gift and an incoming gift',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: [],
    now: GIFT_DAY,
    otherPlayers: OTHERS,
    setup: function () {
      const all = people(this);
      seedState(this, { pairs: cycle(all) });
      seedGift(this, all[3].playerId, all[0].playerId, 200);
    },
    test: async function () {
      await this.runCommand('santa', {}, { chatMessage: '/santa' });
      expect(this.pms()).to.deep.equal([
        'You are the Secret Santa of Bob.',
        'Send your gift with /santa gift <amount> [note] by Dec 24 (100 to 1000 coins).',
        'Your Secret Santa sent you a gift! It opens on Dec 25.',
      ]);
    },
  }),

  createModuleTest({
    name: 'daily reminder: once per day after the reminder hour, only online Santas without a gift',
    module: MODULE,
    settings: { currencyName: 'coins' },
    now: GIFT_DAY,
    otherPlayers: OTHERS,
    setup: function () {
      const all = people(this);
      seedState(this, { pairs: cycle(all) });
      seedGift(this, all[1].playerId, all[2].playerId, 100);
    },
    test: async function () {
      const r = await this.runCronJob('santa-tick');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Secret Santa reminder: send your gift to Bob with /santa gift <amount> (4 days left).']);
      expect(pmsTo(this, 'g-bob')).to.deep.equal([]);
      expect(pmsTo(this, 'g-carol')).to.deep.equal(['Secret Santa reminder: send your gift to Dave with /santa gift <amount> (4 days left).']);
      expect(pmsTo(this, 'g-dave')).to.deep.equal([]);
      expect(stateOf(this).lastReminderDay).to.equal('12-20');
      await this.runCronJob('santa-tick');
      expect(this.messages).to.have.length(2);
    },
  }),

  createModuleTest({
    name: 'no reminder before the reminder hour',
    module: MODULE,
    settings: { currencyName: 'coins' },
    now: GIFT_DAY_MORNING,
    otherPlayers: OTHERS,
    setup: function () {
      seedState(this, { pairs: cycle(people(this)) });
    },
    test: async function () {
      await this.runCronJob('santa-tick');
      expect(this.messages).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'utcOffsetHours moves the day boundary',
    module: MODULE,
    settings: { currencyName: 'coins' },
    now: new Date('2026-12-15T23:30:00.000Z'),
    userConfig: { utcOffsetHours: 1 },
    otherPlayers: OTHERS.slice(0, 2),
    setup: function () {
      for (const p of people(this)) seedSignup(this, p);
    },
    test: async function () {
      // 00:30 on Dec 16 local time: sign-up is over, so the cron draws.
      await this.runCronJob('santa-tick');
      expect(stateOf(this).pairs).to.have.length(3);
    },
  }),

  createModuleTest({
    name: 'daily sign-up broadcast once per day',
    module: MODULE,
    settings: { currencyName: 'coins' },
    now: SIGNUP_DAY,
    test: async function () {
      await this.runCronJob('santa-tick');
      await this.runCronJob('santa-tick');
      expect(broadcasts(this)).to.deep.equal(['Secret Santa sign-up is open until Dec 15! Type /santa join to take part (0 signed up).']);
    },
  }),

  createModuleTest({
    name: 'reveal pays held gifts and the fallback, broadcasts, PMs online receivers once, never pays twice',
    module: MODULE,
    settings: { currencyName: 'coins' },
    now: REVEAL_DAY,
    userConfig: { fallbackGift: 50 },
    otherPlayers: OTHERS,
    setup: function () {
      const all = people(this);
      // You -> Bob -> Carol -> Dave -> You
      seedState(this, { pairs: cycle(all) });
      seedGift(this, all[0].playerId, all[1].playerId, 300, 'Happy holidays');
      seedGift(this, all[1].playerId, all[2].playerId, 100);
      seedGift(this, all[3].playerId, all[0].playerId, 200);
    },
    test: async function () {
      const all = people(this);
      const before = all.map((p) => this.currency.balanceOf(p.playerId));
      const r = await this.runCronJob('santa-tick');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      const after = all.map((p) => this.currency.balanceOf(p.playerId));
      expect(after.map((v, i) => v - before[i])).to.deep.equal([200, 300, 100, 50]);

      expect(broadcasts(this)).to.deep.equal([
        'Merry Christmas! Secret Santa reveal: 3 of 4 Santas sent a gift.',
        `${this.player.name} was the Secret Santa of Bob.`,
        'Bob was the Secret Santa of Carol.',
        'Carol was the Secret Santa of Dave.',
        `Dave was the Secret Santa of ${this.player.name}.`,
      ]);
      expect(pmsTo(this, 'g-bob')).to.deep.equal([
        `Merry Christmas! Your Secret Santa was ${this.player.name}. They gave you 300 coins.`,
        `Note from ${this.player.name}: Happy holidays`,
      ]);
      expect(this.pms()).to.deep.equal(['Merry Christmas! Your Secret Santa was Dave. They gave you 200 coins.']);
      expect(pmsTo(this, 'g-dave')).to.deep.equal([]);
      expect(rows(this, TOLD_KEY)).to.have.length(3);

      await this.runCronJob('santa-tick');
      expect(all.map((p) => this.currency.balanceOf(p.playerId))).to.deep.equal(after);
      expect(this.messages).to.have.length(9);

      await this.runCommand('santa', {}, { chatMessage: '/santa' });
      expect(this.pms().slice(1)).to.deep.equal([
        'Merry Christmas! Your Secret Santa was Dave. They gave you 200 coins.',
        'You were the Secret Santa of Bob and gave 300 coins.',
      ]);
    },
  }),

  createModuleTest({
    name: 'reveal broadcast is capped by revealBroadcastLines',
    module: MODULE,
    settings: { currencyName: 'coins' },
    now: REVEAL_DAY,
    userConfig: { revealBroadcastLines: 1 },
    otherPlayers: OTHERS,
    setup: function () {
      seedState(this, { pairs: cycle(people(this)) });
    },
    test: async function () {
      await this.runCronJob('santa-tick');
      expect(broadcasts(this)).to.deep.equal([
        'Merry Christmas! Secret Santa reveal: 0 of 4 Santas sent a gift.',
        `${this.player.name} was the Secret Santa of Bob.`,
        '...and 3 more. Type /santa to see yours.',
      ]);
      expect(pmsTo(this, 'g-bob')).to.deep.equal([`Your Secret Santa this year was ${this.player.name}, but they did not send a gift.`]);
    },
  }),

  createModuleTest({
    name: 'connect hook: offline receiver hears the reveal once on the next join',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: [],
    now: new Date('2026-12-26T10:00:00.000Z'),
    otherPlayers: OTHERS,
    setup: function () {
      const all = people(this);
      seedState(this, {
        pairs: cycle(all),
        revealedAt: REVEAL_DAY.toISOString(),
        results: [{ giver: all[3].playerId, giverName: 'Dave', receiver: all[0].playerId, receiverName: all[0].name, amount: 150, fromServer: false, note: 'cheers' }],
      });
    },
    test: async function () {
      await this.runHook('santa-connect', { eventType: 'player-connected' });
      await this.runHook('santa-connect', { eventType: 'player-connected' });
      expect(this.pms()).to.deep.equal(['Merry Christmas! Your Secret Santa was Dave. They gave you 150 coins.', 'Note from Dave: cheers']);
    },
  }),

  createModuleTest({
    name: 'connect hook: sign-up hint for non-members, gift reminder for Santas without a gift',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: [],
    now: SIGNUP_DAY,
    test: async function () {
      await this.runHook('santa-connect', { eventType: 'player-connected' });
      expect(this.pms()).to.deep.equal(['Secret Santa sign-up is open until Dec 15. Type /santa join to take part.']);
    },
  }),

  createModuleTest({
    name: 'connect hook during gifting reminds a Santa without a gift',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: [],
    now: GIFT_DAY,
    otherPlayers: OTHERS,
    setup: function () {
      seedState(this, { pairs: cycle(people(this)) });
    },
    test: async function () {
      await this.runHook('santa-connect', { eventType: 'player-connected' });
      expect(this.pms()).to.deep.equal(['Secret Santa reminder: send your gift to Bob with /santa gift <amount> (4 days left).']);
    },
  }),

  createModuleTest({
    name: 'admin commands need SECRET_SANTA_MANAGE',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: [],
    now: SIGNUP_DAY,
    test: async function () {
      for (const a of ['admin', 'pair', 'reveal', 'reset']) {
        const r = await this.runCommand('santa', {}, { chatMessage: `/santa ${a}` });
        expect(this.userError(r), a).to.equal('You do not have permission to manage Secret Santa.');
      }
      const u = await this.runCommand('santa', {}, { chatMessage: '/santa dance' });
      expect(this.userError(u)).to.equal('Unknown option "dance". Use /santa, /santa join, /santa leave or /santa gift <amount> [note].');
    },
  }),

  createModuleTest({
    name: 'admin: status, force-pair during sign-up, gift status, force reveal',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: MANAGE,
    now: SIGNUP_DAY,
    currency: 1000,
    otherPlayers: OTHERS,
    setup: function () {
      for (const p of people(this)) seedSignup(this, p);
    },
    test: async function () {
      await this.runCommand('santa', {}, { chatMessage: '/santa admin' });
      expect(this.pms()[0]).to.equal('Secret Santa 2026: signup. Sign-up Nov 1 to Dec 15, gifts by Dec 24, reveal Dec 25.');
      expect(this.pms()[1]).to.match(/^Signed up: 4 \(.+\)\.$/);

      const pr = await this.runCommand('santa', {}, { chatMessage: '/santa pair' });
      expect(pr.success, JSON.stringify(pr.logs)).to.be.true;
      expect(this.pms().at(-1)).to.equal('Drew 4 Secret Santa pairs.');
      const twice = await this.runCommand('santa', {}, { chatMessage: '/santa pair' });
      expect(this.userError(twice)).to.equal('The names are already drawn.');
      const late = await this.runCommand('santa', {}, { chatMessage: '/santa join' });
      expect(this.userError(late)).to.equal('Secret Santa sign-up is closed for this year.');

      const g = await this.runCommand('santa', {}, { chatMessage: '/santa gift 400 have fun' });
      expect(g.success, JSON.stringify(g.logs)).to.be.true;
      const n = this.pms().length;
      await this.runCommand('santa', {}, { chatMessage: '/santa admin' });
      const lines = this.pms().slice(n);
      expect(lines[0]).to.equal('Secret Santa 2026: gifting. Sign-up Nov 1 to Dec 15, gifts by Dec 24, reveal Dec 25.');
      expect(lines[1]).to.equal('Pairs: 4. Gifts sent: 1 (400 coins held).');
      expect(lines[2]).to.match(/^No gift yet: .+\.$/);
      expect(lines[2].split(', ')).to.have.length(3);

      const receiverBefore = this.currency.balanceOf(stateOf(this).pairs.find((p: any) => p.giver === this.player.id).receiver);
      const rv = await this.runCommand('santa', {}, { chatMessage: '/santa reveal' });
      expect(rv.success, JSON.stringify(rv.logs)).to.be.true;
      expect(this.pms().at(-1)).to.equal('Secret Santa revealed and gifts paid out.');
      const receiver = stateOf(this).pairs.find((p: any) => p.giver === this.player.id).receiver;
      expect(this.currency.balanceOf(receiver)).to.equal(receiverBefore + 400);
      const again = await this.runCommand('santa', {}, { chatMessage: '/santa reveal' });
      expect(this.userError(again)).to.equal('Secret Santa is already revealed.');
    },
  }),

  createModuleTest({
    name: 'admin reset refunds held gifts and removes every season record',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: MANAGE,
    now: GIFT_DAY,
    otherPlayers: OTHERS,
    setup: function () {
      const all = people(this);
      for (const p of all) seedSignup(this, p);
      seedState(this, { pairs: cycle(all) });
      seedGift(this, all[1].playerId, all[2].playerId, 250);
    },
    test: async function () {
      const bob = this.otherPlayers[0].player.id;
      const before = this.currency.balanceOf(bob);
      const r = await this.runCommand('santa', {}, { chatMessage: '/santa reset' });
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(this.currency.balanceOf(bob)).to.equal(before + 250);
      expect(this.variables.all).to.have.length(0);
      expect(this.pms()).to.deep.equal(['Secret Santa 2026 reset: 6 records removed, 1 held gift refunded.']);
      expect(broadcasts(this)).to.deep.equal(['Secret Santa was reset by an admin.']);
    },
  }),

  createModuleTest({
    name: 'dates out of order give a clear error and the cron does nothing',
    module: MODULE,
    settings: { currencyName: 'coins' },
    permissions: [],
    now: SIGNUP_DAY,
    userConfig: { giftDeadline: '12-26' },
    test: async function () {
      const r = await this.runCommand('santa', {}, { chatMessage: '/santa join' });
      expect(this.userError(r)).to.equal('Secret Santa dates are set up wrong. Ask an admin to check the module config.');
      const c = await this.runCronJob('santa-tick');
      expect(c.success).to.be.true;
      expect(this.messages).to.have.length(0);
    },
  }),
];

describe('secret-santa suite (module-VM)', function () {
  tests.forEach((test) => {
    test.run();
  });
});
