import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRegistry, checkRegistry, planRoot } from '../src/registry/run.js';
import { formatError } from '../src/registry/errors.js';
import { schemaErrors } from '../src/registry/schema.js';
import {
  copyFixtureSource,
  editModuleJson,
  expectedDir,
  readText,
  removeAll,
  snapshot,
  writeText,
} from './registry-fixture.js';

function messages(root: string): string[] {
  return planRoot(root).errors.map(formatError);
}

function built(): string {
  const root = copyFixtureSource();
  const plan = buildRegistry(root);
  assert.deepEqual(plan.errors, []);
  return root;
}

describe('registry build', () => {
  it('writes the golden files, with correct hashes and schema-valid output', () => {
    const root = built();
    assert.deepEqual(snapshot(`${root}/registry`), snapshot(expectedDir));

    const manifest = JSON.parse(readText(root, 'registry/registry.json'));
    for (const entry of manifest.modules) {
      for (const details of entry.versionDetails) {
        const bytes = readText(root, `registry/${entry.name}/${details.version}.json`);
        assert.equal(details.sha256, createHash('sha256').update(bytes).digest('hex'));
        assert.deepEqual(schemaErrors('moduleVersion', JSON.parse(bytes)), []);
      }
    }
    assert.deepEqual(schemaErrors('registry', manifest), []);

    const [alpha, legacy] = manifest.modules;
    assert.deepEqual(alpha.versionDetails[0].requiredCapabilities, ['chat.send', 'items.give']);
    assert.equal(alpha.versionDetails[0].minTakaroVersion, '1.2.3');
    assert.equal('minTakaroVersion' in legacy.versionDetails[0], false);
    assert.equal(manifest.modules.some((m: { name: string }) => m.name === 'test-example'), false);

    const version = JSON.parse(readText(root, 'registry/alpha-tools/1.0.0.json')).versions[0];
    assert.equal(version.tag, '1.0.0');
    assert.equal(version.defaultSystemConfig, '{"commands":{"greet":{"cost":0}}}');
  });

  it('is idempotent', () => {
    const root = built();
    const second = buildRegistry(root);
    assert.equal(second.writes.size, 0);
    assert.deepEqual(second.added, []);
    assert.deepEqual(checkRegistry(root), []);
  });

  const changesWithoutBump: Record<string, (root: string) => void> = {
    'function code': (root) => {
      const file = 'modules/alpha-tools/src/commands/greet/index.js';
      writeText(root, file, readText(root, file) + '// changed\n');
    },
    minTakaroVersion: (root) => editModuleJson(root, 'alpha-tools', (json) => (json.minTakaroVersion = '9.9.9')),
  };

  for (const [what, change] of Object.entries(changesWithoutBump)) {
    it(`refuses to change a published version (${what}) and writes nothing`, () => {
      const root = built();
      const before = snapshot(`${root}/registry`);
      change(root);
      const plan = buildRegistry(root);
      assert.ok(
        plan.errors.some((e) => e.message.includes('alpha-tools@1.0.0 is already published and its content changed')),
        JSON.stringify(plan.errors),
      );
      assert.deepEqual(snapshot(`${root}/registry`), before);
    });
  }

  it('adds a bumped version next to the frozen one', () => {
    const root = built();
    const before = snapshot(`${root}/registry`);
    writeText(root, 'modules/alpha-tools/src/functions/alpha-helpers.js', 'export const triple = (v) => v * 3;\n');
    editModuleJson(root, 'alpha-tools', (json) => (json.version = '1.1.0'));
    const plan = buildRegistry(root);
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.added, ['alpha-tools@1.1.0']);

    const after = snapshot(`${root}/registry`);
    assert.equal(after['alpha-tools/1.0.0.json'], before['alpha-tools/1.0.0.json']);
    assert.ok(after['alpha-tools/1.1.0.json']);
    const entry = JSON.parse(after['registry.json']).modules[0];
    assert.deepEqual(entry.versions, ['1.0.0', '1.1.0']);
    assert.equal(entry.latestVersion, '1.1.0');
    assert.deepEqual(entry.versionDetails[0], JSON.parse(before['registry.json']).modules[0].versionDetails[0]);
    assert.deepEqual(checkRegistry(root), []);
  });

  it('refuses a version that is not greater than the latest published', () => {
    const root = built();
    editModuleJson(root, 'alpha-tools', (json) => (json.version = '0.9.0'));
    assert.ok(messages(root).some((m) => m.includes('alpha-tools@0.9.0 must be greater than the latest published version 1.0.0')));

    editModuleJson(root, 'alpha-tools', (json) => (json.version = '1.1.0'));
    assert.deepEqual(buildRegistry(root).errors, []);
    editModuleJson(root, 'alpha-tools', (json) => (json.version = '1.0.5'));
    assert.ok(messages(root).some((m) => m.includes('must be greater than the latest published version 1.1.0')));
  });

  it('keeps published modules whose source is gone or unlisted', () => {
    const removed = built();
    const before = snapshot(`${removed}/registry`);
    removeAll(removed, 'modules/legacyThing');
    assert.deepEqual(buildRegistry(removed).errors, []);
    assert.deepEqual(snapshot(`${removed}/registry`), before);

    const unlisted = built();
    editJsonConfig(unlisted, (config) => (config.unlisted.legacyThing = 'No longer published'));
    assert.deepEqual(buildRegistry(unlisted).errors, []);
    assert.deepEqual(snapshot(`${unlisted}/registry`), before);
  });
});

function editJsonConfig(root: string, mutate: (config: any) => void): void {
  const config = JSON.parse(readText(root, 'registry.config.json'));
  mutate(config);
  writeText(root, 'registry.config.json', JSON.stringify(config, null, 2) + '\n');
}

describe('registry description', () => {
  it('refuses a long description without a summary and uses the summary when given', () => {
    const root = copyFixtureSource();
    const long = 'x'.repeat(600);
    editModuleJson(root, 'alpha-tools', (json) => (json.description = long));
    assert.ok(messages(root).some((m) => m.includes('add a `summary` (≤500 chars)')));

    editModuleJson(root, 'alpha-tools', (json) => (json.summary = 'Short summary.'));
    assert.deepEqual(buildRegistry(root).errors, []);
    const manifest = JSON.parse(readText(root, 'registry/registry.json'));
    assert.equal(manifest.modules[0].description, 'Short summary.');
    assert.equal(JSON.parse(readText(root, 'registry/alpha-tools/1.0.0.json')).versions[0].description, long);
  });
});
