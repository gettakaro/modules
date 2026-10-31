import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'Server messages (module-VM)';

const CRON_JOB = 'Automated message';
const ROTATION_KEY = 'lastMessage';

/** Decoy scope values for the rotation case — one per filter `Automated message.js` applies. */
const OTHER_GAME_SERVER_ID = 'c4e18b70-3a2f-4d95-8b61-9f07d2c5a3e8';
const OTHER_MODULE_ID = '2f6a9d13-7b48-4c02-95e7-8d1a0b3f6c4d';
const OTHER_KEY = 'firstMessage';

const tests = [
  createModuleTest({
    name: 'Can override default message via userConfig',
    module: MODULE,
    userConfig: { messages: ['This is a custom message'] },
    test: async function () {
      const result = await this.runCronJob(CRON_JOB);

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      // A broadcast, not a pm: the cron job sends with no `recipient`.
      expect(this.messages).to.have.length(1);
      expect(this.messages[0].message).to.equal('This is a custom message');
      expect(this.messages[0].recipientGameId).to.be.undefined;

      // The rotation cursor, written under the module + game server scope it is read back with.
      expect(this.variables.all).to.have.length(1);
      const cursor = this.variables.all[0];
      expect(cursor.key).to.equal(ROTATION_KEY);
      expect(cursor.value).to.equal('0');
      expect(cursor.moduleId).to.equal(this.moduleId);
      expect(cursor.gameServerId).to.equal(this.gameServerId);
    },
  }),

  createModuleTest({
    name: 'Can override default message via userConfig with multiple messages',
    module: MODULE,
    userConfig: { messages: ['Test message 1', 'Test message 2'] },
    setup: function () {
      // One decoy per filter `Automated message.js` reads its cursor with, so dropping any single
      // filter makes run 1 read a cursor it should not and send `Test message 2` first.
      const decoy = { value: '0' };
      this.variables.insert({
        ...decoy,
        key: ROTATION_KEY,
        gameServerId: OTHER_GAME_SERVER_ID,
        moduleId: this.moduleId,
      });
      this.variables.insert({
        ...decoy,
        key: ROTATION_KEY,
        gameServerId: this.gameServerId,
        moduleId: OTHER_MODULE_ID,
      });
      this.variables.insert({ ...decoy, key: OTHER_KEY, gameServerId: this.gameServerId, moduleId: this.moduleId });
    },
    test: async function () {
      const cursor = () =>
        this.variables.all.find(
          (row) => row.key === ROTATION_KEY && row.moduleId === this.moduleId && row.gameServerId === this.gameServerId,
        );

      expect((await this.runCronJob(CRON_JOB)).success).to.be.true;
      expect(cursor()?.value).to.equal('0');

      expect((await this.runCronJob(CRON_JOB)).success).to.be.true;
      expect(cursor()?.value).to.equal('1');

      // Index 2 does not exist on the third run, so the rotation wraps to 0 — the branch this case is for.
      expect((await this.runCronJob(CRON_JOB)).success).to.be.true;
      expect(cursor()?.value).to.equal('0');

      expect(this.messages.map((message) => message.message)).to.deep.equal([
        'Test message 1',
        'Test message 2',
        'Test message 1',
      ]);
      // Three decoys plus the one cursor the module created: no decoy was written to, which is
      // what makes the reads above genuinely scoped rather than incidentally correct.
      expect(this.variables.all).to.have.length(4);
      expect(this.variables.all.filter((row) => row.value === '0')).to.have.length(4);
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
