// json-to-module must be lossless: converting a published version file back to a module directory and exporting
// it again has to reproduce the file byte for byte. The 13 formerly bundled modules were imported this way.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildModuleExport } from '../src/registry/export.js';
import { canonicalJson } from '../src/registry/serialize.js';
import { repoRoot } from './registry-fixture.js';

const converter = path.join(repoRoot, 'dist', 'scripts', 'json-to-module.js');
const registryDir = path.join(repoRoot, 'registry');

const versionFiles = fs
  .readdirSync(registryDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) =>
    fs
      .readdirSync(path.join(registryDir, entry.name))
      .filter((file) => file.endsWith('.json'))
      .map((file) => `${entry.name}/${file}`),
  );

describe('module round trip', () => {
  it('finds published versions', () => {
    assert.ok(versionFiles.length > 0);
  });

  for (const versionFile of versionFiles) {
    it(`${versionFile} survives json-to-module and back`, () => {
      const published = fs.readFileSync(path.join(registryDir, versionFile), 'utf-8');
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtrip-'));
      try {
        const moduleDir = path.join(workDir, 'module');
        execFileSync(process.execPath, [converter, path.join(registryDir, versionFile), moduleDir], { stdio: 'pipe' });
        assert.equal(canonicalJson(buildModuleExport(moduleDir)), published);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    });
  }
});
