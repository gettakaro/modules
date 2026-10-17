import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistry, checkRegistry, planRoot } from '../src/registry/run.js';
import { compareWithBase } from '../src/registry/compare-base.js';
import { formatError } from '../src/registry/errors.js';
import { emptyTree, PublishedTree } from '../src/registry/tree.js';
import { loadTreeFromDirectory } from '../src/registry/fs-tree.js';
import { copyFixtureSource, editModuleJson, readText, removeAll, writeText } from './registry-fixture.js';
import fs from 'node:fs';
import path from 'node:path';

function messages(root: string): string[] {
  return planRoot(root).errors.map(formatError);
}

function expectError(root: string, fragment: string): void {
  const found = messages(root);
  assert.ok(found.some((m) => m.includes(fragment)), `expected "${fragment}" in:\n${found.join('\n')}`);
}

/** Rename the alpha-tools module and its directory, so only the name rules can fire. */
function renameModule(root: string, name: string): void {
  fs.renameSync(path.join(root, 'modules/alpha-tools'), path.join(root, 'modules', name));
  editModuleJson(root, name, (json) => (json.name = name));
}

describe('name rules', () => {
  const refused: [string, string][] = [
    ['Alpha-Tools', 'must be kebab-case'],
    ['alphaTools', 'must be kebab-case'],
    ['alpha_tools', 'must be kebab-case'],
    ['-alpha', 'must be kebab-case'],
    ['a'.repeat(51), 'at most 50 characters'],
    ['schema', 'is reserved'],
  ];
  for (const [name, fragment] of refused) {
    it(`refuses ${name}`, () => {
      const root = copyFixtureSource();
      renameModule(root, name);
      expectError(root, fragment);
    });
  }

  it('accepts a renamed kebab-case module', () => {
    const root = copyFixtureSource();
    renameModule(root, 'beta-tools');
    assert.deepEqual(messages(root), []);
  });

  it('accepts an allow-listed legacy name and refuses the same name when not allow-listed', () => {
    const root = copyFixtureSource();
    assert.deepEqual(messages(root), []);
    const config = JSON.parse(readText(root, 'registry.config.json'));
    config.legacyModuleNames = [];
    writeText(root, 'registry.config.json', JSON.stringify(config));
    expectError(root, 'legacyThing');
  });

  it('refuses a name that differs from the directory', () => {
    const root = copyFixtureSource();
    editModuleJson(root, 'alpha-tools', (json) => (json.name = 'beta-tools'));
    expectError(root, 'must equal the directory name "alpha-tools"');
  });

  it('accepts a test- name on an unlisted module', () => {
    assert.deepEqual(messages(copyFixtureSource()), []);
  });

  it('refuses an unlisted entry without a module directory', () => {
    const root = copyFixtureSource();
    removeAll(root, 'modules/example');
    expectError(root, '"unlisted" names "example"');
  });
});

describe('version rules', () => {
  for (const version of ['latest', '1.0', '1.0.0-beta.1', '01.0.0', '1.0.0+build', '1.0.0.0']) {
    it(`refuses ${version} on a listed module`, () => {
      const root = copyFixtureSource();
      editModuleJson(root, 'alpha-tools', (json) => (json.version = version));
      expectError(root, '"version" must be a semantic version');
    });
  }

  it('accepts the same non-semver version on an unlisted module', () => {
    assert.deepEqual(messages(copyFixtureSource()), []);
  });

  it('refuses a missing version and a malformed minTakaroVersion', () => {
    const root = copyFixtureSource();
    editModuleJson(root, 'alpha-tools', (json) => delete json.version);
    expectError(root, '"version" must be a semantic version');
    editModuleJson(root, 'alpha-tools', (json) => {
      json.version = '1.0.0';
      json.minTakaroVersion = '1.x';
    });
    expectError(root, 'minTakaroVersion');
  });
});

describe('module schema', () => {
  it('refuses an unknown top-level key', () => {
    const root = copyFixtureSource();
    editModuleJson(root, 'alpha-tools', (json) => (json.surprise = true));
    expectError(root, "unknown property 'surprise'");
  });

  it('refuses a command without a function', () => {
    const root = copyFixtureSource();
    editModuleJson(root, 'alpha-tools', (json) => delete json.commands.greet.function);
    expectError(root, "must have required property 'function'");
  });

  it('refuses a function path that escapes the module directory', () => {
    const root = copyFixtureSource();
    writeText(root, 'modules/outside.js', 'export {};\n');
    editModuleJson(root, 'alpha-tools', (json) => (json.commands.greet.function = '../outside.js'));
    expectError(root, 'escapes module directory');
  });

  it('refuses a function path that escapes through a symlink', () => {
    const root = copyFixtureSource();
    writeText(root, 'outside.js', 'export {};\n');
    fs.symlinkSync(path.join(root, 'outside.js'), path.join(root, 'modules/alpha-tools/src/link.js'));
    editModuleJson(root, 'alpha-tools', (json) => (json.commands.greet.function = 'src/link.js'));
    expectError(root, 'escapes module directory via symlink');
  });

  it('refuses a missing function file', () => {
    const root = copyFixtureSource();
    removeAll(root, 'modules/alpha-tools/src/commands/greet/index.js');
    expectError(root, 'not found');
  });

  it('refuses config given as an array', () => {
    const root = copyFixtureSource();
    editModuleJson(root, 'alpha-tools', (json) => (json.config = []));
    expectError(root, '/config: must be object');
  });

  it('refuses duplicate argument positions and names', () => {
    const root = copyFixtureSource();
    editModuleJson(root, 'alpha-tools', (json) => (json.commands.greet.arguments[1].position = 0));
    expectError(root, 'more than one argument at position 0');
    editModuleJson(root, 'alpha-tools', (json) => {
      json.commands.greet.arguments[1].position = 1;
      json.commands.greet.arguments[1].name = 'player';
    });
    expectError(root, 'more than one argument named "player"');
  });

  it('reports errors from several modules together', () => {
    const root = copyFixtureSource();
    editModuleJson(root, 'alpha-tools', (json) => (json.surprise = true));
    editModuleJson(root, 'legacyThing', (json) => (json.version = 'latest'));
    const found = messages(root);
    assert.ok(found.some((m) => m.startsWith('modules/alpha-tools/module.json:')));
    assert.ok(found.some((m) => m.startsWith('modules/legacyThing/module.json:')));
  });

  it('refuses an invalid registry config', () => {
    const root = copyFixtureSource();
    writeText(root, 'registry.config.json', JSON.stringify({ description: 'no name' }));
    expectError(root, "must have required property 'name'");
  });
});

describe('published tree', () => {
  function built(): string {
    const root = copyFixtureSource();
    assert.deepEqual(buildRegistry(root).errors, []);
    return root;
  }

  function checkFails(root: string, fragment: string): void {
    const errors = checkRegistry(root).map(formatError);
    assert.ok(errors.some((e) => e.includes(fragment)), `expected "${fragment}" in:\n${errors.join('\n')}`);
  }

  it('detects an edited version file through its sha256', () => {
    const root = built();
    const file = 'registry/alpha-tools/1.0.0.json';
    writeText(root, file, readText(root, file).replace('Hello', 'Hi'));
    checkFails(root, 'registry/alpha-tools/1.0.0.json: sha256 does not match');
  });

  it('detects a deleted listed file', () => {
    const root = built();
    removeAll(root, 'registry/legacyThing/1.0.0.json');
    checkFails(root, 'registry/legacyThing/1.0.0.json: listed in registry.json but the file is missing');
  });

  it('detects stray files', () => {
    const root = built();
    writeText(root, 'registry/alpha-tools/notes.txt', 'hi');
    writeText(root, 'registry/README.md', 'hi');
    checkFails(root, 'registry/alpha-tools/notes.txt: unexpected file');
    checkFails(root, 'registry/README.md: unexpected file');
  });

  it('detects a manifest whose latestVersion is not the highest', () => {
    const root = built();
    const manifest = JSON.parse(readText(root, 'registry/registry.json'));
    manifest.modules[0].versions = ['1.0.0'];
    manifest.modules[0].latestVersion = '1.0.0';
    manifest.modules[0].versionDetails[0].version = '2.0.0';
    writeText(root, 'registry/registry.json', JSON.stringify(manifest, null, 2) + '\n');
    checkFails(root, 'versionDetails must list the same versions');
  });

  it('detects stale output', () => {
    const root = built();
    editModuleJson(root, 'alpha-tools', (json) => (json.version = '1.1.0'));
    checkFails(root, 'registry/ is out of date; run npm run registry:build');
  });
});

describe('base comparison', () => {
  function tree(): PublishedTree {
    const root = copyFixtureSource();
    buildRegistry(root);
    return loadTreeFromDirectory(`${root}/registry`);
  }

  function clone(source: PublishedTree): PublishedTree {
    return { manifestText: source.manifestText, files: new Map(source.files) };
  }

  function editManifest(source: PublishedTree, mutate: (manifest: any) => void): PublishedTree {
    const copy = clone(source);
    const manifest = JSON.parse(copy.manifestText as string);
    mutate(manifest);
    copy.manifestText = JSON.stringify(manifest, null, 2) + '\n';
    return copy;
  }

  it('accepts an identical tree, a new version and an empty base', () => {
    const base = tree();
    assert.deepEqual(compareWithBase(base, clone(base)), []);
    const head = clone(base);
    head.files.set('alpha-tools/1.1.0.json', '{}\n');
    assert.deepEqual(compareWithBase(base, head), []);
    assert.deepEqual(compareWithBase(emptyTree(), base), []);
  });

  it('refuses a modified file', () => {
    const base = tree();
    const head = clone(base);
    head.files.set('alpha-tools/1.0.0.json', head.files.get('alpha-tools/1.0.0.json') + ' ');
    assert.match(compareWithBase(base, head).map(formatError).join('\n'), /alpha-tools\/1.0.0.json: published version file was modified/);
  });

  it('refuses a removed version, a removed module and a changed details entry', () => {
    const base = tree();
    const removedVersion = editManifest(base, (m) => {
      m.modules[0].versions = [];
      m.modules[0].versionDetails = [];
    });
    removedVersion.files.delete('alpha-tools/1.0.0.json');
    const errors = compareWithBase(base, removedVersion).map(formatError).join('\n');
    assert.match(errors, /alpha-tools\/1.0.0.json: published version file was removed/);
    assert.match(errors, /alpha-tools@1.0.0 was removed/);

    const removedModule = editManifest(base, (m) => m.modules.shift());
    assert.match(compareWithBase(base, removedModule).map(formatError).join('\n'), /module "alpha-tools" was removed/);

    const changedDetails = editManifest(base, (m) => (m.modules[0].versionDetails[0].requiredCapabilities = []));
    assert.match(compareWithBase(base, changedDetails).map(formatError).join('\n'), /versionDetails of alpha-tools@1.0.0 changed/);
  });
});

describe('real repository', () => {
  it('has a valid, up-to-date registry/', () => {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    assert.deepEqual(checkRegistry(root).map(formatError), []);
  });
});
