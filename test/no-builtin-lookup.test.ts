// Registry modules are not built-in, so code that finds a module by Takaro's `builtin` flag finds nothing
// once the module comes from a registry (gettakaro/modules#68). Look modules up by name instead.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './registry-fixture.js';

const BUILTIN_KEY = /\bbuiltin\s*:/;

function jsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('module code', () => {
  it('never looks a module up by the builtin flag', () => {
    const modulesDir = path.join(repoRoot, 'modules');
    const offenders = fs
      .readdirSync(modulesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => jsFiles(path.join(modulesDir, entry.name, 'src')))
      .flatMap((file) =>
        fs
          .readFileSync(file, 'utf-8')
          .split('\n')
          .flatMap((line, index) =>
            BUILTIN_KEY.test(line) ? [`${path.relative(repoRoot, file)}:${index + 1}: ${line.trim()}`] : [],
          ),
      );
    assert.deepEqual(offenders, []);
  });
});
