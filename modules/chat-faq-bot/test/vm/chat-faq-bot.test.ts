import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const HOOK = 'faq-responder';
const NOW = new Date('2026-11-05T12:00:00.000Z');

const chat = (msg: string) => ({ eventType: 'chat-message' as const, eventData: { msg, channel: 'global' } });

const SETTINGS = { commandPrefix: '@', currencyName: 'Dukes' };

const tests = [
  createModuleTest({
    name: 'Default money entry answers by PM with placeholders filled',
    module: MODULE,
    settings: SETTINGS,
    now: NOW,
    test: async function () {
      const result = await this.runHook(HOOK, chat('Hey, how do I get money here?'));

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const pms = this.pms();
      expect(pms).to.have.length(2);
      expect(pms[0]).to.equal(`[FAQ] ${this.player.name}, you earn Dukes by playing: kill zombies and enemies, and stay online.`);
      expect(pms[1]).to.contain('@daily').and.contain('@vote');
      expect(this.messages.every((m) => m.recipientGameId === this.pog.gameId)).to.be.true;
    },
  }),

  createModuleTest({
    name: 'Public entry broadcasts with a custom placeholder',
    module: MODULE,
    settings: SETTINGS,
    now: NOW,
    userConfig: {
      entries: [
        { topic: 'discord', match: 'any', triggers: ['discord'], answer: 'Join {discord}', reply: 'public', cooldownSeconds: 60, playerCooldownSeconds: 0 },
      ],
      placeholders: [{ name: 'discord', value: 'discord.gg/abc' }],
      messagePrefix: '',
    },
    test: async function () {
      await this.runHook(HOOK, chat('whats the DISCORD?'));
      expect(this.messages).to.have.length(1);
      expect(this.messages[0].message).to.equal('Join discord.gg/abc');
      expect(this.messages[0].recipientGameId).to.be.undefined;
    },
  }),

  createModuleTest({
    name: 'Server cooldown blocks a second answer',
    module: MODULE,
    settings: SETTINGS,
    now: NOW,
    userConfig: {
      entries: [
        { topic: 'wipe', match: 'any', triggers: ['wipe'], answer: 'Friday', reply: 'public', cooldownSeconds: 60, playerCooldownSeconds: 0 },
      ],
    },
    test: async function () {
      await this.runHook(HOOK, chat('when is the wipe'));
      await this.runHook(HOOK, chat('wipe when??'));
      expect(this.messages).to.have.length(1);

      const row = this.variables.all.find((v) => v.key === 'faq_cd:wipe');
      expect(row, 'cooldown row').to.exist;
      expect(row!.playerId == null).to.be.true;
      expect(Number(row!.value)).to.equal(NOW.getTime() + 60_000);
    },
  }),

  createModuleTest({
    name: 'Expired cooldown row is reused and the answer is sent again',
    module: MODULE,
    settings: SETTINGS,
    now: NOW,
    userConfig: {
      entries: [
        { topic: 'wipe', match: 'any', triggers: ['wipe'], answer: 'Friday', reply: 'public', cooldownSeconds: 60, playerCooldownSeconds: 0 },
      ],
    },
    setup: function () {
      // A stale row whose stored "until" is in the past (expiry not yet cleaned up).
      this.variables.insert({
        key: 'faq_cd:wipe',
        value: String(NOW.getTime() - 1000),
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
      });
    },
    test: async function () {
      await this.runHook(HOOK, chat('wipe?'));
      expect(this.messages).to.have.length(1);
      const rows = this.variables.all.filter((v) => v.key === 'faq_cd:wipe');
      expect(rows).to.have.length(1);
      expect(Number(rows[0].value)).to.equal(NOW.getTime() + 60_000);
    },
  }),

  createModuleTest({
    name: 'Per-player cooldown is stored per player',
    module: MODULE,
    settings: SETTINGS,
    now: NOW,
    userConfig: {
      entries: [{ topic: 'rules', match: 'any', triggers: ['rules'], answer: 'Be nice', reply: 'pm', cooldownSeconds: 0, playerCooldownSeconds: 300 }],
    },
    test: async function () {
      await this.runHook(HOOK, chat('what are the rules'));
      await this.runHook(HOOK, chat('rules pls'));
      expect(this.pms()).to.deep.equal(['[FAQ] Be nice']);
      const row = this.variables.all.find((v) => v.key === 'faq_pcd:rules');
      expect(row!.playerId).to.equal(this.player.id);
    },
  }),

  createModuleTest({
    name: 'Ignores commands, configured prefixes, short messages and non-matches',
    module: MODULE,
    settings: SETTINGS,
    now: NOW,
    test: async function () {
      await this.runHook(HOOK, chat('@faq discord'));
      await this.runHook(HOOK, chat('/discord'));
      await this.runHook(HOOK, chat('dc'));
      await this.runHook(HOOK, chat('nice base you have'));
      await this.runHook(HOOK, chat('the moneylender sells honey'));
      await this.runHook(HOOK, chat('lets go to the disco'));
      expect(this.messages).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'Messages without a player (server chat) are ignored',
    module: MODULE,
    settings: SETTINGS,
    now: NOW,
    test: async function () {
      const result = await this.runHook(HOOK, { ...chat('join our discord'), withPlayer: false });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.messages).to.have.length(0);
    },
  }),

  createModuleTest({
    name: '"all" mode needs every word of a keyword set, any order',
    module: MODULE,
    settings: SETTINGS,
    now: NOW,
    userConfig: {
      entries: [{ topic: 'money', match: 'all', triggers: ['get money'], answer: 'Kill zombies', reply: 'pm', cooldownSeconds: 0, playerCooldownSeconds: 0 }],
      messagePrefix: '',
    },
    test: async function () {
      await this.runHook(HOOK, chat('where is my money'));
      expect(this.pms()).to.deep.equal([]);
      await this.runHook(HOOK, chat('Money, how to GET it?'));
      expect(this.pms()).to.deep.equal(['Kill zombies']);
    },
  }),

  createModuleTest({
    name: 'Regex mode matches and an invalid regex is skipped without crashing',
    module: MODULE,
    settings: SETTINGS,
    now: NOW,
    userConfig: {
      entries: [
        { topic: 'broken', match: 'regex', triggers: ['(unclosed'], answer: 'never', reply: 'pm', cooldownSeconds: 0, playerCooldownSeconds: 0 },
        { topic: 'lcb', match: 'regex', triggers: ['\\bhow many\\b.*\\b(lcb|claims?)\\b'], answer: 'Two claims', reply: 'pm', cooldownSeconds: 0, playerCooldownSeconds: 0 },
      ],
      messagePrefix: '',
    },
    test: async function () {
      const result = await this.runHook(HOOK, chat('How many claims can I place?'));
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['Two claims']);
    },
  }),

  createModuleTest({
    name: 'PM failure falls back to public chat',
    module: MODULE,
    settings: SETTINGS,
    now: NOW,
    userConfig: {
      entries: [{ topic: 'rules', match: 'any', triggers: ['rules'], answer: 'Be nice', reply: 'pm', cooldownSeconds: 0, playerCooldownSeconds: 0 }],
      messagePrefix: '',
    },
    setup: function () {
      this.client.stubs.gameserver.gameServerControllerSendMessage?.callsFake(async (_id: string, body: any) => {
        if (body?.opts?.recipient) throw new Error('whisper not supported');
        return { data: { data: {} } } as never;
      });
    },
    test: async function () {
      const result = await this.runHook(HOOK, chat('rules?'));
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const calls = this.client.stubs.gameserver.gameServerControllerSendMessage!.getCalls();
      expect(calls).to.have.length(2);
      expect(calls[1].args[1]).to.deep.equal({ message: 'Be nice' });
    },
  }),

  createModuleTest({
    name: 'faq without topic lists topics',
    module: MODULE,
    settings: SETTINGS,
    test: async function () {
      // No topic typed: Takaro passes the argument default, "list".
      const result = await this.runCommand('faq', {}, { chatMessage: '@faq' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const again = await this.runCommand('faq', { topic: 'list' }, { chatMessage: '@faq list' });
      expect(again.success, JSON.stringify(again.logs)).to.be.true;
      const listing = [
        'FAQ topics: money, discord, rules, wipe, commands, admin',
        'Type @faq <topic> to read one, or just ask in chat.',
      ];
      expect(this.pms()).to.deep.equal([...listing, ...listing]);
    },
  }),

  createModuleTest({
    name: 'faq <question> finds the topic from the full chat line, ignoring cooldowns',
    module: MODULE,
    settings: SETTINGS,
    test: async function () {
      const result = await this.runCommand('faq', { topic: 'next' }, { chatMessage: '@faq next wipe' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['[FAQ] Next wipe: not scheduled yet. Watch Discord for the date.']);
    },
  }),

  createModuleTest({
    name: 'faq with unknown topic gives a clear error',
    module: MODULE,
    settings: SETTINGS,
    test: async function () {
      const result = await this.runCommand('faq', { topic: 'pizza' }, { chatMessage: '@faq pizza' });
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.match(/No FAQ topic "pizza"\. Topics: money/);
    },
  }),

  createModuleTest({
    name: 'faqlist needs FAQ_BOT_MANAGE',
    module: MODULE,
    settings: SETTINGS,
    permissions: [],
    test: async function () {
      const result = await this.runCommand('faqlist');
      expect(result.success).to.be.false;
      expect(this.userError(result)).to.match(/permission/);
    },
  }),

  createModuleTest({
    name: 'faqlist shows entries and flags invalid regex',
    module: MODULE,
    settings: SETTINGS,
    permissions: [{ permission: 'FAQ_BOT_MANAGE' }],
    userConfig: {
      entries: [
        { topic: 'broken', match: 'regex', triggers: ['(unclosed'], answer: 'x', reply: 'public', cooldownSeconds: 10, playerCooldownSeconds: 20 },
      ],
    },
    test: async function () {
      const result = await this.runCommand('faqlist');
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        '1 FAQ entries (first match wins):',
        '1. broken [regex, public, cd 10s/20s] INVALID REGEX: (unclosed: (unclosed',
      ]);
    },
  }),

  createModuleTest({
    name: 'faqtest previews the matching entry',
    module: MODULE,
    settings: SETTINGS,
    permissions: [{ permission: 'FAQ_BOT_MANAGE' }],
    test: async function () {
      const result = await this.runCommand('faqtest', { message: 'how' }, { chatMessage: '@faqtest how do i earn coins' });
      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const pms = this.pms();
      expect(pms[0]).to.equal('Matches "money" (pm). Answer preview (no cooldown used):');
      expect(pms).to.have.length(3);
      expect(this.variables.all).to.have.length(0);
    },
  }),
];

describe('chat-faq-bot (module-VM)', function () {
  tests.forEach((t) => t.run());
});
