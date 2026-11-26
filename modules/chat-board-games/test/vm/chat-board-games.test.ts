import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const NOW = new Date('2026-11-26T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

// The harness runs commands as one acting player; switch it to play both sides of a game.
function actAs(t: any, who: { player: any; pog: any }) {
  t.alice ??= { player: t.context.player, pog: t.context.pog };
  t.context.player = who.player;
  t.context.pog = who.pog;
}
const me = (t: any) => t.alice ?? { player: t.player, pog: t.pog };
const bob = (t: any) => t.otherPlayers[0];
const carol = (t: any) => t.otherPlayers[1];
const pmsOf = (t: any, who: any) => t.client.pmsTo(who.pog.gameId);
const broadcasts = (t: any) => t.messages.filter((m: any) => m.recipientGameId === undefined).map((m: any) => m.message);
const rows = (t: any, key: string) => t.variables.all.filter((r: any) => r.key === key);
const balance = (t: any, who: any) => t.currency.balanceOf(who.player.id);

async function cmd(t: any, who: any, name: string, line: string) {
  actAs(t, who);
  const r = await t.runCommand(name, {}, { chatMessage: line });
  return r;
}

async function ok(t: any, who: any, name: string, line: string) {
  const r = await cmd(t, who, name, line);
  expect(r.success, `${line}: ${t.userError(r) ?? JSON.stringify(r.logs)}`).to.be.true;
  return r;
}

async function fails(t: any, who: any, name: string, line: string, msg: string) {
  const r = await cmd(t, who, name, line);
  expect(r.success, line).to.be.false;
  expect(t.userError(r), line).to.equal(msg);
}

function seedGame(t: any, game: Record<string, unknown>) {
  const a = me(t);
  const b = bob(t);
  const row = {
    id: 'g1',
    game: 'ttt',
    status: 'active',
    bet: 0,
    challengerId: a.player.id,
    challengerName: a.player.name,
    challengerGameId: a.pog.gameId,
    opponentId: b.player.id,
    opponentName: b.player.name,
    opponentGameId: b.pog.gameId,
    createdAt: NOW.toISOString(),
    lastMoveAt: NOW.toISOString(),
    challengerMark: 'X',
    turn: 'X',
    round: 1,
    score: { X: 0, O: 0 },
    board: Array(9).fill(''),
    ...game,
  };
  t.variables.insert({ key: 'cbg_game', value: JSON.stringify(row), gameServerId: t.gameServerId, moduleId: t.moduleId, playerId: a.player.id });
  return row;
}

const base = {
  module: MODULE,
  now: NOW,
  player: { name: 'Alice' },
  currency: 500,
  otherPlayers: [
    { name: 'Bob', currency: 500 },
    { name: 'Carol', currency: 20 },
  ],
  permissions: [] as any[],
  settings: { currencyName: 'Takaro coins' },
};

describe('chat-board-games', () => {
  createModuleTest({
    ...base,
    name: 'challenge validates input',
    userConfig: { maxBet: 200 },
    test: async function () {
      const usage = 'Usage: /challenge <player> <ttt|c4|rps> [bet]';
      await fails(this, me(this), 'challenge', '/challenge', usage);
      await fails(this, me(this), 'challenge', '/challenge Bob', usage);
      await fails(this, me(this), 'challenge', '/challenge Alice ttt', 'You cannot challenge yourself.');
      await fails(this, me(this), 'challenge', '/challenge Zed ttt', 'No online player matches "Zed".');
      await fails(this, me(this), 'challenge', '/challenge Bob ttt 300', 'The maximum bet is 200 Takaro coins.');
      await fails(this, carol(this), 'challenge', '/challenge Bob c4 50', 'You do not have 50 Takaro coins.');
      expect(rows(this, 'cbg_game')).to.have.length(0);
      expect(balance(this, me(this))).to.equal(500);
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'full tic-tac-toe game with a bet: stake held, winner takes the pot, stats, broadcast',
    random: 0.1, // challenger starts (X)
    test: async function () {
      const a = me(this);
      const b = bob(this);
      await ok(this, a, 'challenge', '/challenge bob ttt 50');
      expect(balance(this, a)).to.equal(450);
      expect(pmsOf(this, a)).to.deep.equal(['You challenged Bob to tic-tac-toe for 50 Takaro coins each (winner takes 100). They have 2 min to accept.']);
      expect(pmsOf(this, b)).to.deep.equal([
        'Alice challenges you to tic-tac-toe for 50 Takaro coins each (winner takes 100).',
        'Type /accept or /decline within 2 min.',
      ]);

      await fails(this, a, 'accept', '/accept', 'You have no open challenge to accept.');
      await fails(this, b, 'move', '/move 1', 'Accept the challenge first with /accept.');
      await ok(this, b, 'accept', '/accept');
      expect(balance(this, b)).to.equal(450);
      const bobPms = pmsOf(this, b);
      expect(bobPms.slice(2)).to.deep.equal([
        'Game on: tic-tac-toe, Alice (X) vs Bob (O). Pot: 100 Takaro coins. X starts.',
        '1 | 2 | 3',
        '4 | 5 | 6',
        '7 | 8 | 9',
        'Waiting for Alice (X).',
      ]);
      expect(pmsOf(this, a).slice(-1)).to.deep.equal(['Your turn (X) vs Bob: /move <1-9>']);

      await fails(this, b, 'move', '/move 5', "It is Alice's turn. You are O.");
      await ok(this, a, 'move', '/move 1');
      await fails(this, b, 'move', '/move 1', 'Square 1 is taken. Pick a free square.');
      await fails(this, b, 'move', '/move 10', 'Pick a free square from 1 to 9.');
      await ok(this, b, 'move', '/move 4');
      expect(pmsOf(this, a).slice(-5)).to.deep.equal(['Bob played 4.', 'X | 2 | 3', 'O | 5 | 6', '7 | 8 | 9', 'Your turn (X) vs Bob: /move <1-9>']);
      await ok(this, a, 'move', '/move 2');
      await ok(this, b, 'move', '/move 5');
      await ok(this, a, 'move', '/move 3');

      expect(balance(this, a)).to.equal(550);
      expect(balance(this, b)).to.equal(450);
      expect(pmsOf(this, a).slice(-4)).to.deep.equal(['X | X | X', 'O | O | 6', '7 | 8 | 9', 'You beat Bob at tic-tac-toe and won 100 Takaro coins!']);
      expect(pmsOf(this, b).slice(-1)).to.deep.equal(['Alice beat you at tic-tac-toe. You lost your 50 Takaro coins stake.']);
      expect(broadcasts(this)).to.deep.equal(['Alice beat Bob at tic-tac-toe and won 100 Takaro coins.']);
      expect(rows(this, 'cbg_game')).to.have.length(0);

      const stats = rows(this, 'cbg_stats').map((r: any) => JSON.parse(r.value));
      expect(stats.find((s: any) => s.name === 'Alice')).to.deep.include({ wins: 1, losses: 0, net: 50 });
      expect(stats.find((s: any) => s.name === 'Bob')).to.deep.include({ wins: 0, losses: 1, net: -50 });

      await ok(this, a, 'gamestats', '/gamestats');
      expect(pmsOf(this, a).slice(-2)).to.deep.equal(['You: 1 wins, 0 losses, 0 draws. Bets: +50 Takaro coins.', 'tic-tac-toe: 1 wins, 0 losses, 0 draws']);
      await ok(this, a, 'gamestats', '/gamestats bob');
      expect(pmsOf(this, a).slice(-2)[0]).to.equal('Bob: 0 wins, 1 losses, 0 draws. Bets: -50 Takaro coins.');
      await ok(this, b, 'gametop', '/gametop');
      expect(pmsOf(this, b).slice(-3)).to.deep.equal(['Board games top 2:', '1. Alice - 1 wins, 0 losses, 0 draws', '2. Bob - 0 wins, 1 losses, 0 draws']);
      await ok(this, b, 'gametop', '/gametop c4');
      expect(pmsOf(this, b).slice(-1)).to.deep.equal(['No finished games yet. Be the first: /challenge <player> <game> [bet]']);
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'a player in a game cannot start or receive another challenge',
    test: async function () {
      await ok(this, me(this), 'challenge', '/challenge Bob rps');
      await fails(this, me(this), 'challenge', '/challenge Carol ttt', 'You already have an open challenge. Withdraw it with /forfeit.');
      await fails(this, carol(this), 'challenge', '/challenge Bob ttt', 'Bob is already in a game. Try again later.');
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'tic-tac-toe draw refunds both stakes',
    setup: function () {
      // X O X / X O O / O X _   -> X plays 9 = draw
      seedGame(this, { bet: 30, board: ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', ''] });
    },
    test: async function () {
      await ok(this, me(this), 'move', '/move 9');
      expect(balance(this, me(this))).to.equal(530);
      expect(balance(this, bob(this))).to.equal(530);
      expect(pmsOf(this, bob(this)).slice(-1)).to.deep.equal(['Draw! Alice and Bob tied at tic-tac-toe. Stakes refunded (30 Takaro coins each).']);
      expect(broadcasts(this)).to.deep.equal(['Alice and Bob drew at tic-tac-toe.']);
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'connect-four: pieces drop, full column refused, vertical four wins',
    random: 0.9, // opponent starts (Bob = X)
    test: async function () {
      const a = me(this);
      const b = bob(this);
      await ok(this, a, 'challenge', '/challenge Bob connect4');
      await ok(this, b, 'accept', '/accept');
      expect(pmsOf(this, a).slice(-9, -1)).to.deep.equal([
        'Game on: connect-four, Bob (X) vs Alice (O). X starts.',
        '|.|.|.|.|.|.|.|',
        '|.|.|.|.|.|.|.|',
        '|.|.|.|.|.|.|.|',
        '|.|.|.|.|.|.|.|',
        '|.|.|.|.|.|.|.|',
        '|.|.|.|.|.|.|.|',
        ' 1 2 3 4 5 6 7',
      ]);
      await fails(this, b, 'move', '/move 8', 'Pick a column from 1 to 7.');
      for (const [who, col] of [[b, 1], [a, 2], [b, 1], [a, 2], [b, 1], [a, 2]] as const) {
        await ok(this, who, 'move', `/move ${col}`);
      }
      expect(pmsOf(this, b).slice(-8, -1)).to.deep.equal([
        '|.|.|.|.|.|.|.|',
        '|.|.|.|.|.|.|.|',
        '|.|.|.|.|.|.|.|',
        '|X|O|.|.|.|.|.|',
        '|X|O|.|.|.|.|.|',
        '|X|O|.|.|.|.|.|',
        ' 1 2 3 4 5 6 7',
      ]);
      await ok(this, b, 'move', '/move 1');
      expect(pmsOf(this, a).slice(-1)).to.deep.equal(['Bob beat you at connect-four.']);
      expect(broadcasts(this)).to.deep.equal(['Bob beat Alice at connect-four.']);
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'connect-four full column and diagonal win',
    setup: function () {
      const board = Array(42).fill('');
      for (let r = 0; r < 6; r++) board[r * 7 + 6] = r % 2 ? 'X' : 'O'; // column 7 full
      // diagonal for X: (5,0) (4,1) (3,2) need (2,3)
      board[5 * 7 + 0] = 'X';
      board[5 * 7 + 1] = 'O'; board[4 * 7 + 1] = 'X';
      board[5 * 7 + 2] = 'O'; board[4 * 7 + 2] = 'O'; board[3 * 7 + 2] = 'X';
      board[5 * 7 + 3] = 'O'; board[4 * 7 + 3] = 'X'; board[3 * 7 + 3] = 'O';
      seedGame(this, { game: 'c4', board });
    },
    test: async function () {
      await fails(this, me(this), 'move', '/move 7', 'Column 7 is full. Pick another column.');
      await ok(this, me(this), 'move', '/move 4');
      expect(pmsOf(this, me(this)).slice(-1)).to.deep.equal(['You beat Bob at connect-four!']);
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'rock-paper-scissors: picks are hidden, same pick replays, winner paid',
    test: async function () {
      const a = me(this);
      const b = bob(this);
      await ok(this, a, 'challenge', '/challenge Bob rps 100');
      await ok(this, b, 'accept', '/accept');
      expect(pmsOf(this, b).slice(-2)).to.deep.equal([
        'Game on: rock-paper-scissors, Alice vs Bob. Pot: 200 Takaro coins.',
        'Pick in secret: /move rock, paper or scissors',
      ]);
      await fails(this, a, 'move', '/move lizard', 'Pick one: /move rock, paper or scissors');
      await ok(this, a, 'move', '/move rock');
      expect(pmsOf(this, a).slice(-1)).to.deep.equal(['You picked rock. Waiting for Bob.']);
      expect(pmsOf(this, b).slice(-1)).to.deep.equal(['Alice has picked. Your pick: /move rock, paper or scissors']);
      await fails(this, a, 'move', '/move paper', 'You already picked rock this round.');
      await ok(this, b, 'move', '/move r');
      expect(pmsOf(this, a).slice(-2)).to.deep.equal(['Bob: rock, Alice: rock. Same pick, no point.', 'Pick again: /move rock, paper or scissors']);
      await ok(this, b, 'move', '/move paper');
      await ok(this, a, 'move', '/move scissors');
      expect(pmsOf(this, a).slice(-2)).to.deep.equal(['Alice: scissors, Bob: paper.', 'You beat Bob at rock-paper-scissors (scissors beats paper) and won 200 Takaro coins!']);
      expect(balance(this, a)).to.equal(600);
      expect(balance(this, b)).to.equal(400);
      expect(rows(this, 'cbg_rps')).to.have.length(0);
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'rock-paper-scissors best of 3 with a house fee',
    userConfig: { rpsBestOf: 3, houseFeePercent: 10 },
    setup: function () {
      seedGame(this, { game: 'rps', bet: 100, board: null });
    },
    test: async function () {
      const a = me(this);
      const b = bob(this);
      await ok(this, a, 'move', '/move paper');
      await ok(this, b, 'move', '/move rock');
      expect(pmsOf(this, b).slice(-2)).to.deep.equal(['Bob: rock, Alice: paper. Alice wins the round. Score: you 0, Alice 1.', 'Next round: /move rock, paper or scissors']);
      await ok(this, a, 'move', '/move paper');
      await ok(this, b, 'move', '/move scissors');
      await ok(this, a, 'move', '/move rock');
      await ok(this, b, 'move', '/move paper');
      expect(pmsOf(this, b).slice(-1)).to.deep.equal(['You beat Alice at rock-paper-scissors (2-1) and won 180 Takaro coins (20 Takaro coins house fee)!']);
      expect(balance(this, b)).to.equal(680);
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'decline and withdraw refund the challenger',
    test: async function () {
      const a = me(this);
      const b = bob(this);
      await ok(this, a, 'challenge', '/challenge Bob ttt 40');
      await fails(this, carol(this), 'decline', '/decline', 'You have no open challenge to decline.');
      await ok(this, b, 'decline', '/decline');
      expect(balance(this, a)).to.equal(500);
      expect(pmsOf(this, a).slice(-1)).to.deep.equal(['Bob declined your challenge. Your 40 Takaro coins stake was refunded.']);
      expect(pmsOf(this, b).slice(-1)).to.deep.equal(['You declined the challenge from Alice.']);

      await ok(this, a, 'challenge', '/challenge Bob c4 40');
      await ok(this, a, 'forfeit', '/forfeit');
      expect(balance(this, a)).to.equal(500);
      expect(pmsOf(this, b).slice(-1)).to.deep.equal(['Alice withdrew the challenge.']);
      expect(rows(this, 'cbg_game')).to.have.length(0);
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'forfeit gives the pot to the other player',
    setup: function () {
      seedGame(this, { bet: 50 });
    },
    test: async function () {
      await ok(this, me(this), 'forfeit', '/forfeit');
      expect(balance(this, bob(this))).to.equal(600);
      expect(pmsOf(this, bob(this)).slice(-1)).to.deep.equal(['You beat Alice at tic-tac-toe (Alice forfeited) and won 100 Takaro coins!']);
      await fails(this, me(this), 'forfeit', '/forfeit', 'You are not in a game.');
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'board shows the game and whose turn it is',
    setup: function () {
      seedGame(this, { bet: 10, lastMoveAt: minutesAgo(1), board: ['X', '', '', '', 'O', '', '', '', ''] });
    },
    test: async function () {
      await ok(this, me(this), 'board', '/board');
      expect(pmsOf(this, me(this))).to.deep.equal([
        'tic-tac-toe vs Bob. Pot: 20 Takaro coins.',
        'X | 2 | 3',
        '4 | O | 6',
        '7 | 8 | 9',
        'Your turn (X) vs Bob: /move <1-9> (2 min left)',
      ]);
      await fails(this, carol(this), 'board', '/board', 'You are not in a game. Start one with /challenge <player> <game> [bet].');
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'cron: expired challenge is refunded',
    setup: function () {
      seedGame(this, { status: 'pending', bet: 75, createdAt: minutesAgo(3) });
      // The stake was taken when the challenge was made.
      this.currency.deduct(this.player.id, 75);
    },
    test: async function () {
      const r = await this.runCronJob('cbg-tick');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(balance(this, me(this))).to.equal(500);
      expect(pmsOf(this, me(this))).to.deep.equal(['Bob did not answer your tic-tac-toe challenge in time. Your 75 Takaro coins stake was refunded.']);
      expect(pmsOf(this, bob(this))).to.deep.equal(['The tic-tac-toe challenge from Alice expired.']);
      expect(rows(this, 'cbg_game')).to.have.length(0);
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'cron: fresh challenge stays, turn reminder is sent once',
    setup: function () {
      seedGame(this, { turn: 'O', lastMoveAt: minutesAgo(1.5) });
    },
    test: async function () {
      await this.runCronJob('cbg-tick');
      await this.runCronJob('cbg-tick');
      expect(pmsOf(this, bob(this))).to.deep.equal(['Your move in tic-tac-toe: /move <1-9> (2 min left, /board shows the game).']);
      expect(pmsOf(this, me(this))).to.deep.equal([]);
      expect(rows(this, 'cbg_game')).to.have.length(1);
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'cron: turn timeout = the slow player loses (default)',
    setup: function () {
      seedGame(this, { bet: 50, turn: 'O', lastMoveAt: minutesAgo(4) });
      this.currency.deduct(this.player.id, 50);
      this.currency.deduct(this.otherPlayers[0].player.id, 50);
    },
    test: async function () {
      await this.runCronJob('cbg-tick');
      expect(balance(this, me(this))).to.equal(550);
      expect(balance(this, bob(this))).to.equal(450);
      expect(pmsOf(this, me(this)).slice(-1)).to.deep.equal(['You beat Bob at tic-tac-toe (Bob ran out of time) and won 100 Takaro coins!']);
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'cron: turn timeout in refund mode cancels and refunds both',
    userConfig: { turnTimeoutAction: 'refund' },
    setup: function () {
      seedGame(this, { bet: 50, turn: 'O', lastMoveAt: minutesAgo(4) });
      this.currency.deduct(this.player.id, 50);
      this.currency.deduct(this.otherPlayers[0].player.id, 50);
    },
    test: async function () {
      await this.runCronJob('cbg-tick');
      expect(balance(this, me(this))).to.equal(500);
      expect(balance(this, bob(this))).to.equal(500);
      expect(pmsOf(this, bob(this))).to.deep.equal(['Bob did not move in time, the tic-tac-toe game was cancelled. Your 50 Takaro coins stake was refunded.']);
      expect(rows(this, 'cbg_stats')).to.have.length(0);
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'cron: rps nobody picked = refund',
    setup: function () {
      seedGame(this, { game: 'rps', board: null, bet: 20, lastMoveAt: minutesAgo(5) });
      this.currency.deduct(this.player.id, 20);
      this.currency.deduct(this.otherPlayers[0].player.id, 20);
    },
    test: async function () {
      await this.runCronJob('cbg-tick');
      expect(balance(this, me(this))).to.equal(500);
      expect(balance(this, bob(this))).to.equal(500);
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'boardgames help, admin list and cancel',
    setup: function () {
      seedGame(this, { bet: 25, challengerId: this.otherPlayers[1].player.id, challengerName: 'Carol', challengerGameId: this.otherPlayers[1].pog.gameId });
      this.currency.deduct(this.otherPlayers[1].player.id, 20);
    },
    test: async function () {
      await ok(this, me(this), 'boardgames', '/boardgames');
      expect(pmsOf(this, me(this))[0]).to.equal('Board games: ttt (tic-tac-toe), c4 (connect-four), rps (rock-paper-scissors).');
      await fails(this, me(this), 'boardgames', '/boardgames cancel Bob', 'You do not have permission to manage board games.');
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'admin cancel refunds every stake',
    permissions: [{ permission: 'BOARD_GAMES_MANAGE' }],
    setup: function () {
      seedGame(this, {
        bet: 10,
        challengerId: this.otherPlayers[1].player.id,
        challengerName: 'Carol',
        challengerGameId: this.otherPlayers[1].pog.gameId,
      });
      this.currency.deduct(this.otherPlayers[1].player.id, 10);
      this.currency.deduct(this.otherPlayers[0].player.id, 10);
    },
    test: async function () {
      await ok(this, me(this), 'boardgames', '/boardgames list');
      expect(pmsOf(this, me(this))).to.deep.equal(['1 board game:', 'Carol vs Bob: tic-tac-toe, active. Pot: 20 Takaro coins.']);
      await ok(this, me(this), 'boardgames', '/boardgames cancel bob');
      expect(balance(this, bob(this))).to.equal(500);
      expect(balance(this, carol(this))).to.equal(20);
      expect(pmsOf(this, bob(this))).to.deep.equal(['An admin cancelled your tic-tac-toe game. Your 10 Takaro coins stake was refunded.']);
      expect(rows(this, 'cbg_game')).to.have.length(0);
    },
  }).run();

  createModuleTest({
    ...base,
    name: 'disabled game and bets off',
    userConfig: { enableConnectFour: false, maxBet: 0 },
    test: async function () {
      await fails(this, me(this), 'challenge', '/challenge Bob c4', 'connect-four is turned off here. Games: ttt, rps.');
      await fails(this, me(this), 'challenge', '/challenge Bob ttt 5', 'Bets are turned off on this server. Play without a bet.');
    },
  }).run();
});
