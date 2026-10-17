import fs from 'node:fs';
import path from 'node:path';
import { buildModuleExport, ModuleSourceError } from './export.js';
import { RegistryError } from './errors.js';
import { compareWithBase } from './compare-base.js';
import { loadTreeFromDirectory, writeTree } from './fs-tree.js';
import { loadTreeFromGit } from './git-tree.js';
import { ModuleSource, planRegistry, RegistryPlan } from './plan.js';

const CONFIG_FILE = 'registry.config.json';

function loadSource(modulesDir: string, dir: string): ModuleSource {
  const moduleDir = path.join(modulesDir, dir);
  const source: ModuleSource = { dir };
  try {
    source.json = JSON.parse(fs.readFileSync(path.join(moduleDir, 'module.json'), 'utf-8'));
  } catch (err) {
    source.loadError = `cannot read module.json: ${(err as Error).message}`;
    return source;
  }
  try {
    source.export = buildModuleExport(moduleDir);
  } catch (err) {
    // Malformed module.json can fail the export in ways the schema reports better; surface any message.
    if (!(err instanceof ModuleSourceError) && !(err instanceof TypeError)) throw err;
    source.exportError = err.message;
  }
  return source;
}

function loadSources(root: string): ModuleSource[] {
  const modulesDir = path.join(root, 'modules');
  if (!fs.existsSync(modulesDir)) return [];
  return fs
    .readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((dir) => loadSource(modulesDir, dir));
}

/** Plan the registry of the checkout at `root` against its committed registry/ directory. */
export function planRoot(root: string): RegistryPlan {
  const configPath = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    return { errors: [{ path: CONFIG_FILE, message: 'not found' }], writes: new Map(), added: [] };
  }
  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    return {
      errors: [{ path: CONFIG_FILE, message: `is not valid JSON: ${(err as Error).message}` }],
      writes: new Map(),
      added: [],
    };
  }
  return planRegistry({
    config,
    sources: loadSources(root),
    published: loadTreeFromDirectory(path.join(root, 'registry')),
  });
}

/** Write the new version files and registry.json. All or nothing: any error writes nothing. */
export function buildRegistry(root: string): RegistryPlan {
  const plan = planRoot(root);
  if (plan.errors.length === 0) writeTree(path.join(root, 'registry'), plan.writes);
  return plan;
}

/** Validate without writing. Stale output is an error, and so is any change to what `baseRef` published. */
export function checkRegistry(root: string, baseRef?: string): RegistryError[] {
  const plan = planRoot(root);
  const errors = [...plan.errors];
  if (errors.length === 0 && plan.writes.size > 0) {
    errors.push({
      path: 'registry',
      message: 'registry/ is out of date; run npm run registry:build and commit the result',
    });
  }
  if (baseRef) {
    errors.push(
      ...compareWithBase(loadTreeFromGit(root, baseRef), loadTreeFromDirectory(path.join(root, 'registry'))),
    );
  }
  return errors;
}
