import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const NOW = new Date('2026-11-05T12:00:00.000Z');
const POLL_ID = 'testpoll';
const ACTIVE_KEY = 'polls_active';
const VOTE_KEY = `polls_vote:${POLL_ID}`;
const MANAGE = [{ permission: 'POLLS_MANAGE' }];

function seedPoll(t: any, endsAt = new Date(NOW.getTime() + 10 * 60000)) {
  t.variables.insert({
    key: ACTIVE_KEY,
    value: JSON.stringify({
      id: POLL_ID,
      question: 'Next wipe?',
      options: ['Friday', 'Saturday', 'Sunday'],
      createdBy: 'Admin',
      createdAt: NOW.toISOString(),
      endsAt: endsAt.toISOString(),
    }),
    gameServerId: t.gameServerId,
    moduleId: t.moduleId,
  });
}

function seedVote(t: any, playerId: string, idx: number) {
  t.variables.insert({ key: VOTE_KEY, value: JSON.stringify(idx), gameServerId: t.gameServerId, moduleId: t.moduleId, playerId });
}

const broadcasts = (t: any) => t.messages.filter((m: any) => m.recipientGameId === undefined).map((m: any) => m.message);
const voteRows = (t: any) => t.variables.all.filter((r: any) => r.key === VOTE_KEY);
const activeRows = (t: any) => t.variables.all.filter((r: any) => r.key === ACTIVE_KEY);

const tests = [
  createModuleTest({
    name: 'poll create is refused without POLLS_MANAGE',
    module: MODULE,
    permissions: [],
    test: async function () {
      const r = await this.runCommand('poll', {}, { chatMessage: '/poll create 5 Best map? | A | B' });
      expect(r.success).to.be.false;
      expect(this.userError(r)).to.equal('You do not have permission to manage polls.');
      expect(this.variables.all).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'poll create stores the poll and broadcasts numbered options',
    module: MODULE,
    permissions: MANAGE,
    now: NOW,
    test: async function () {
      const r = await this.runCommand('poll', {}, { chatMessage: '/poll create 15 Which map next wipe? | Navezgane | Random Gen |  | PREGEN 10k' });
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      const rows = activeRows(this);
      expect(rows).to.have.length(1);
      const poll = JSON.parse(rows[0].value);
      expect(poll.question).to.equal('Which map next wipe?');
      expect(poll.options).to.deep.equal(['Navezgane', 'Random Gen', 'PREGEN 10k']);
      expect(poll.endsAt).to.equal(new Date(NOW.getTime() + 15 * 60000).toISOString());
      expect(rows[0].moduleId).to.equal(this.moduleId);
      expect(broadcasts(this)).to.deep.equal([
        'New poll (15 min): Which map next wipe?',
        '1. Navezgane',
        '2. Random Gen',
        '3. PREGEN 10k',
        'Vote with /pollvote <number>. See results with /poll.',
      ]);
    },
  }),

  createModuleTest({
    name: 'poll create validates input',
    module: MODULE,
    permissions: MANAGE,
    userConfig: { maxOptions: 3, maxDurationMinutes: 60 },
    test: async function () {
      const cases: Array<[string, string]> = [
        ['/poll create', 'Usage: /poll create <minutes> <question> | <option1> | <option2> | ...'],
        ['/poll create soon Q | A | B', 'Usage: /poll create <minutes> <question> | <option1> | <option2> | ...'],
        ['/poll create 0 Q | A | B', 'Duration must be between 1 and 60 minutes.'],
        ['/poll create 61 Q | A | B', 'Duration must be between 1 and 60 minutes.'],
        ['/poll create 5 Q | A', 'A poll needs at least 2 options, separated by |. Usage: /poll create <minutes> <question> | <option1> | <option2> | ...'],
        ['/poll create 5 Q | A | B | C | D', 'A poll can have at most 3 options.'],
        ['/poll create 5 | A | B', 'The poll needs a question. Usage: /poll create <minutes> <question> | <option1> | <option2> | ...'],
        ['/poll banana', 'Unknown option "banana". Use /poll, /poll create or /poll close.'],
      ];
      for (const [line, msg] of cases) {
        const r = await this.runCommand('poll', {}, { chatMessage: line });
        expect(r.success, line).to.be.false;
        expect(this.userError(r), line).to.equal(msg);
      }
      expect(this.variables.all).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'only one poll can run at a time',
    module: MODULE,
    permissions: MANAGE,
    now: NOW,
    setup: function () {
      seedPoll(this);
    },
    test: async function () {
      const r = await this.runCommand('poll', {}, { chatMessage: '/poll create 5 Another? | A | B' });
      expect(this.userError(r)).to.equal('A poll is already running: "Next wipe?". Close it first with /poll close.');
      expect(activeRows(this)).to.have.length(1);
    },
  }),

  createModuleTest({
    name: 'pollvote without a running poll',
    module: MODULE,
    permissions: [],
    test: async function () {
      const r = await this.runCommand('pollvote', { option: 1 });
      expect(this.userError(r)).to.equal('No poll is running right now.');
    },
  }),

  createModuleTest({
    name: 'pollvote counts once, can be changed, rejects bad numbers',
    module: MODULE,
    permissions: [],
    now: NOW,
    setup: function () {
      seedPoll(this);
    },
    test: async function () {
      const bad = await this.runCommand('pollvote', { option: 4 });
      expect(this.userError(bad)).to.equal('Pick a number from 1 to 3. See the options with /poll.');

      let r = await this.runCommand('pollvote', { option: 2 });
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      r = await this.runCommand('pollvote', { option: 2 });
      expect(r.success).to.be.true;
      r = await this.runCommand('pollvote', { option: 3 });
      expect(r.success).to.be.true;

      const rows = voteRows(this);
      expect(rows).to.have.length(1);
      expect(rows[0].playerId).to.equal(this.player.id);
      expect(JSON.parse(rows[0].value)).to.equal(2);
      expect(this.pms()).to.deep.equal([
        'Vote counted: 2. Saturday. You can change it until the poll closes.',
        'You already voted for 2. Saturday.',
        'Vote changed to 3. Sunday.',
      ]);
      expect(broadcasts(this)).to.deep.equal([]);
    },
  }),

  createModuleTest({
    name: 'pollvote announces first votes when announceVotes is on',
    module: MODULE,
    permissions: [],
    now: NOW,
    userConfig: { announceVotes: true },
    setup: function () {
      seedPoll(this);
    },
    test: async function () {
      await this.runCommand('pollvote', { option: 1 });
      expect(broadcasts(this)).to.deep.equal([`${this.player.name} voted in the poll! Use /poll to see it.`]);
    },
  }),

  createModuleTest({
    name: 'pollvote after the end time is refused',
    module: MODULE,
    permissions: [],
    now: NOW,
    setup: function () {
      seedPoll(this, new Date(NOW.getTime() - 1000));
    },
    test: async function () {
      const r = await this.runCommand('pollvote', { option: 1 });
      expect(this.userError(r)).to.equal('This poll has ended. Results are coming in a moment.');
      expect(voteRows(this)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'poll shows live results and your own vote',
    module: MODULE,
    permissions: [],
    now: NOW,
    otherPlayers: [{ name: 'A' }, { name: 'B' }],
    setup: function () {
      seedPoll(this);
      seedVote(this, this.player.id, 0);
      seedVote(this, this.otherPlayers[0].player.id, 0);
      seedVote(this, this.otherPlayers[1].player.id, 2);
    },
    test: async function () {
      const r = await this.runCommand('poll', {}, { chatMessage: '/poll' });
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Poll: Next wipe? (10 min left, 3 votes)',
        '1. Friday - 2 votes (67%)',
        '2. Saturday - 0 votes (0%)',
        '3. Sunday - 1 vote (33%)',
        'You voted for 1. Friday. Change it with /pollvote <number>.',
      ]);
    },
  }),

  createModuleTest({
    name: 'duplicate vote rows for one player (double-tap race) count once',
    module: MODULE,
    permissions: [],
    now: NOW,
    setup: function () {
      seedPoll(this);
      seedVote(this, this.player.id, 0);
      seedVote(this, this.player.id, 1);
    },
    test: async function () {
      await this.runCommand('poll', {}, { chatMessage: '/poll' });
      expect(this.pms()[0]).to.equal('Poll: Next wipe? (10 min left, 1 vote)');
    },
  }),

  createModuleTest({
    name: 'poll without a running poll',
    module: MODULE,
    permissions: [],
    test: async function () {
      const r = await this.runCommand('poll', {}, { chatMessage: '/poll' });
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['No poll is running right now.']);
    },
  }),

  createModuleTest({
    name: 'poll close is admin-only',
    module: MODULE,
    permissions: [],
    now: NOW,
    setup: function () {
      seedPoll(this);
    },
    test: async function () {
      const r = await this.runCommand('poll', {}, { chatMessage: '/poll close' });
      expect(this.userError(r)).to.equal('You do not have permission to manage polls.');
      expect(activeRows(this)).to.have.length(1);
    },
  }),

  createModuleTest({
    name: 'poll close broadcasts results, pays voters, posts to Discord, then poll shows last results',
    module: MODULE,
    permissions: MANAGE,
    now: NOW,
    currency: 0,
    userConfig: { voteReward: 25, postResultsToDiscord: true, discordChannelId: '123456' },
    otherPlayers: [{ name: 'A' }, { name: 'B' }],
    setup: function () {
      seedPoll(this);
      seedVote(this, this.player.id, 1);
      seedVote(this, this.otherPlayers[0].player.id, 1);
      seedVote(this, this.otherPlayers[1].player.id, 0);
    },
    test: async function () {
      const r = await this.runCommand('poll', {}, { chatMessage: '/poll close' });
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(broadcasts(this)).to.deep.equal([
        'Poll closed: Next wipe?',
        '1. Friday - 1 vote (33%)',
        '2. Saturday - 2 votes (67%)',
        '3. Sunday - 0 votes (0%)',
        'Winner: Saturday (3 votes)',
        'Thanks for voting! 3 voters got 25 test coin.',
      ]);
      expect(activeRows(this)).to.have.length(0);
      expect(voteRows(this)).to.have.length(0);
      expect(this.currency.balanceOf(this.pog.playerId)).to.equal(25);
      expect(this.currency.balanceOf(this.otherPlayers[0].pog.playerId)).to.equal(25);

      const discord = this.client.stubs.discord.discordControllerSendMessage;
      expect(discord).to.have.been.calledOnce;
      expect(discord?.firstCall.args[0]).to.equal('123456');
      expect((discord?.firstCall.args[1] as any).message).to.contain('**Winner: Saturday** (3 votes)');

      const show = await this.runCommand('poll', {}, { chatMessage: '/poll' });
      expect(show.success).to.be.true;
      expect(this.pms()).to.deep.equal([
        'No poll is running. Last poll: Next wipe?',
        '1. Friday - 1 vote (33%)',
        '2. Saturday - 2 votes (67%)',
        '3. Sunday - 0 votes (0%)',
        'Winner: Saturday (3 votes)',
      ]);

      const again = await this.runCommand('poll', {}, { chatMessage: '/poll close' });
      expect(this.userError(again)).to.equal('No poll is running.');
    },
  }),

  createModuleTest({
    name: 'Discord and rewards are off by default; ties are reported',
    module: MODULE,
    permissions: MANAGE,
    now: NOW,
    currency: 0,
    otherPlayers: [{ name: 'A' }],
    setup: function () {
      seedPoll(this);
      seedVote(this, this.player.id, 0);
      seedVote(this, this.otherPlayers[0].player.id, 2);
    },
    test: async function () {
      const r = await this.runCommand('poll', {}, { chatMessage: '/poll close' });
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(broadcasts(this).at(-1)).to.equal('Tie between: Friday, Sunday (2 votes)');
      expect(this.client.stubs.discord.discordControllerSendMessage).to.not.have.been.called;
      expect(this.client.stubs.playerOnGameserver.playerOnGameServerControllerAddCurrency).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'cron leaves a running poll alone',
    module: MODULE,
    now: NOW,
    setup: function () {
      seedPoll(this);
    },
    test: async function () {
      const r = await this.runCronJob('poll-tick');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(this.messages).to.have.length(0);
      expect(activeRows(this)).to.have.length(1);
    },
  }),

  createModuleTest({
    name: 'cron closes an expired poll',
    module: MODULE,
    now: NOW,
    setup: function () {
      seedPoll(this, new Date(NOW.getTime() - 1000));
    },
    test: async function () {
      const r = await this.runCronJob('poll-tick');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(broadcasts(this)[0]).to.equal('Poll ended: Next wipe?');
      expect(broadcasts(this).at(-1)).to.equal('Nobody voted.');
      expect(activeRows(this)).to.have.length(0);
      const last = this.variables.all.filter((row: any) => row.key === 'polls_last');
      expect(last).to.have.length(1);
    },
  }),

  createModuleTest({
    name: 'cron with no poll does nothing',
    module: MODULE,
    test: async function () {
      const r = await this.runCronJob('poll-tick');
      expect(r.success, JSON.stringify(r.logs)).to.be.true;
      expect(this.messages).to.have.length(0);
    },
  }),
];

describe('polls suite (module-VM)', function () {
  tests.forEach((test) => {
    test.run();
  });
});
