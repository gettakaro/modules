import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildModuleExport, ModuleSourceError } from '../src/registry/export.js';
import { deriveRequiredCapabilities } from '../src/registry/capabilities.js';
import { schemaErrors } from '../src/registry/schema.js';

const GREET = "import { data } from '@takaro/helpers';\nawait data.pog.pm('hi');\n";
const GIVE = "import { takaro } from '@takaro/helpers';\nawait takaro.gameserver.gameServerControllerGiveItem();\n";

/** A module directory in a temp dir: module.json plus the given files. */
function moduleDir(moduleJson: Record<string, unknown>, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-export-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(moduleJson, null, 2));
  return dir;
}

const base = { name: 'shop-kit', description: 'Test module', version: '1.0.0' };

describe('module export', () => {
  it('exports shop actions and required permissions, and both formats accept them', () => {
    const moduleJson = {
      ...base,
      commands: { greet: { function: 'src/greet.js', requiredPermissions: ['SHOP_KIT_GREET'] } },
      shopActions: {
        give: { description: 'Gives an item', function: 'src/give.js' },
        plain: { function: 'src/greet.js' },
      },
    };
    assert.deepEqual(schemaErrors('module', moduleJson), []);

    const exported = buildModuleExport(moduleDir(moduleJson, { 'src/greet.js': GREET, 'src/give.js': GIVE }));
    const version = exported.versions[0];
    assert.deepEqual(version.commands[0].requiredPermissions, ['SHOP_KIT_GREET']);
    assert.deepEqual(version.shopActions, [
      { name: 'give', description: 'Gives an item', function: GIVE },
      { name: 'plain', description: null, function: GREET },
    ]);
    assert.deepEqual(Object.keys(version).slice(-2), ['permissions', 'shopActions']);
    assert.deepEqual(schemaErrors('moduleVersion', exported), []);
  });

  it('adds neither key when module.json declares neither', () => {
    const exported = buildModuleExport(
      moduleDir({ ...base, commands: { greet: { function: 'src/greet.js' } } }, { 'src/greet.js': GREET }),
    );
    const version = exported.versions[0];
    assert.equal('shopActions' in version, false);
    assert.equal('requiredPermissions' in version.commands[0], false);
  });

  it('derives capabilities from shop action code', () => {
    const exported = buildModuleExport(
      moduleDir({ ...base, shopActions: { give: { function: 'src/give.js' } } }, { 'src/give.js': GIVE }),
    );
    assert.deepEqual(deriveRequiredCapabilities(exported.versions[0]), ['items.give']);
  });

  it('refuses a shop action path that escapes the module directory', () => {
    const dir = moduleDir({ ...base, shopActions: { give: { function: '../outside.js' } } }, {});
    assert.throws(
      () => buildModuleExport(dir),
      (err: unknown) => err instanceof ModuleSourceError && /escapes module directory/.test(err.message),
    );
  });
});
