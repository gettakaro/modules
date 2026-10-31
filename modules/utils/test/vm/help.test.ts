import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'help command suite (module-VM)';

const tests = [
  createModuleTest({
    name: 'Shows all available commands when no argument provided',
    module: MODULE,
    test: async function () {
      // No arguments at all. `'all'` reaches the module because the harness applies the command
      // DTO's own defaultValue, exactly as the parser would — hand-writing it would make this
      // case stop testing what its name says.
      const result = await this.runCommand('help');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const pms = this.pms();
      expect(pms[0]).to.include('Available commands:');
      expect(pms.some((msg) => msg.includes('help:'))).to.be.true;
      expect(pms.some((msg) => msg.includes('ping:'))).to.be.true;
    },
  }),

  createModuleTest({
    name: 'Shows specific command help when command name provided',
    module: MODULE,
    test: async function () {
      const result = await this.runCommand('help', { command: 'ping' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.have.length(1);
      expect(this.pms()[0]).to.include('ping:');
      expect(this.pms()[0]).to.include('pong');
    },
  }),

  createModuleTest({
    name: 'Search returns commands with matching names',
    module: MODULE,
    test: async function () {
      const result = await this.runCommand('help', { command: 'search', searchTerm: 'ping' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()[0]).to.include('Commands matching "ping":');
      expect(this.pms().some((msg) => msg.includes('ping:'))).to.be.true;
    },
  }),

  createModuleTest({
    name: 'Search returns commands with matching help text',
    module: MODULE,
    test: async function () {
      const result = await this.runCommand('help', { command: 'search', searchTerm: 'pong' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()[0]).to.include('Commands matching "pong":');
      // 'pong' appears in ping's helpText, not in any command name.
      expect(this.pms().some((msg) => msg.includes('ping:'))).to.be.true;
    },
  }),

  createModuleTest({
    name: 'Search is case-insensitive',
    module: MODULE,
    test: async function () {
      const result = await this.runCommand('help', { command: 'search', searchTerm: 'PING' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()[0]).to.include('Commands matching "PING":');
      expect(this.pms().some((msg) => msg.includes('ping:'))).to.be.true;
    },
  }),

  createModuleTest({
    name: 'Search supports partial matches',
    module: MODULE,
    test: async function () {
      const result = await this.runCommand('help', { command: 'search', searchTerm: 'hel' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()[0]).to.include('Commands matching "hel":');
      expect(this.pms().some((msg) => msg.includes('help:'))).to.be.true;
    },
  }),

  createModuleTest({
    name: 'Search returns appropriate message when no matches found',
    module: MODULE,
    test: async function () {
      const result = await this.runCommand('help', { command: 'search', searchTerm: 'nonexistentcommand' });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.pms()).to.deep.equal(['No commands found matching "nonexistentcommand".']);
    },
  }),

  createModuleTest({
    name: 'Search works across multiple modules',
    module: MODULE,
    alsoInstalled: [{ module: new URL('../../../gimme/', import.meta.url), userConfig: { items: [], commands: ['say test'] } }],
    test: async function () {
      // 'randomly' appears only in gimme's help text and 'command' only in utils' — one term per
      // installation, so this fails if the second installation is dropped anywhere along
      // `moduleCommands.flat()`.
      const fromSecondary = await this.runCommand('help', { command: 'search', searchTerm: 'randomly' });
      expect(fromSecondary.success, JSON.stringify(fromSecondary.logs)).to.be.true;
      expect(this.pms()).to.include('gimme: Randomly selects item from a list of items and entities.');

      const fromPrimary = await this.runCommand('help', { command: 'search', searchTerm: 'command' });
      expect(fromPrimary.success, JSON.stringify(fromPrimary.logs)).to.be.true;
      expect(this.pms().some((msg) => msg.startsWith('help:'))).to.be.true;
    },
  }),

  createModuleTest({
    name: 'Does not show commands from disabled modules',
    module: MODULE,
    alsoInstalled: [{ module: new URL('../../../teleports/', import.meta.url), systemConfig: { enabled: false } }],
    test: async function () {
      const result = await this.runCommand('help');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const pms = this.pms();
      expect(pms[0]).to.include('Available commands:');
      expect(pms.some((msg) => msg.includes('help:'))).to.be.true;
      expect(pms.some((msg) => msg.includes('ping:'))).to.be.true;
      expect(pms.some((msg) => msg.includes('settp:'))).to.be.false;
      expect(pms.some((msg) => msg.includes('teleport:'))).to.be.false;
    },
  }),

  createModuleTest({
    name: 'Does not show individually disabled commands',
    module: MODULE,
    systemConfig: { commands: { ping: { enabled: false } } },
    test: async function () {
      const result = await this.runCommand('help');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      const pms = this.pms();
      expect(pms[0]).to.include('Available commands:');
      expect(pms.some((msg) => msg.includes('help:'))).to.be.true;
      expect(pms.some((msg) => msg.includes('ping:'))).to.be.false;
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
