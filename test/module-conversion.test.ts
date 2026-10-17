import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulesDir = path.join(repoRoot, 'modules');
const converter = path.join(repoRoot, 'dist', 'scripts', 'module-to-json.js');

const moduleNames = fs
  .readdirSync(modulesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(modulesDir, entry.name, 'module.json')))
  .map((entry) => entry.name);

interface ExportedEntity {
  name: string;
  function: string;
}

describe('module conversion', () => {
  it('finds module directories', () => {
    assert.ok(moduleNames.length > 0);
  });

  for (const moduleName of moduleNames) {
    it(`${moduleName} converts to Takaro import JSON`, () => {
      const moduleDir = path.join(modulesDir, moduleName);
      const expectedName = JSON.parse(fs.readFileSync(path.join(moduleDir, 'module.json'), 'utf-8')).name;

      const stdout = execFileSync(process.execPath, [converter, moduleDir], { encoding: 'utf-8' });
      const exported = JSON.parse(stdout);

      assert.equal(exported.name, expectedName);
      assert.equal(exported.versions.length, 1);

      const version = exported.versions[0];
      const entities: ExportedEntity[] = [
        ...(version.commands ?? []),
        ...(version.hooks ?? []),
        ...(version.cronJobs ?? []),
        ...(version.functions ?? []),
      ];
      for (const entity of entities) {
        assert.equal(typeof entity.function, 'string', `${entity.name} has no function`);
        assert.ok(entity.function.length > 0, `${entity.name} has an empty function`);
      }
    });
  }
});
