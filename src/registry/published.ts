import { RegistryManifest } from '../types/module.js';
import { RegistryError } from './errors.js';
import { schemaErrors } from './schema.js';
import { compareSemver, maxSemver } from './semver.js';
import { sha256Hex } from './serialize.js';
import { MANIFEST_FILE, PublishedTree, versionFilePath } from './tree.js';

const REGISTRY_ROOT = 'registry';

export interface ParsedTree {
  manifest: RegistryManifest | null;
  errors: RegistryError[];
}

function treeError(file: string, message: string): RegistryError {
  return { path: `${REGISTRY_ROOT}/${file}`, message };
}

/** Parse and check a published tree on its own: manifest shape, sorting, hashes and stray files. */
export function checkPublishedTree(tree: PublishedTree): ParsedTree {
  const errors: RegistryError[] = [];

  if (tree.manifestText === null) {
    for (const file of tree.files.keys()) {
      errors.push(treeError(file, `unexpected file; ${MANIFEST_FILE} is missing`));
    }
    return { manifest: null, errors };
  }

  let manifest: RegistryManifest;
  try {
    manifest = JSON.parse(tree.manifestText) as RegistryManifest;
  } catch (err) {
    return { manifest: null, errors: [treeError(MANIFEST_FILE, `is not valid JSON: ${(err as Error).message}`)] };
  }
  const shapeErrors = schemaErrors('registry', manifest);
  if (shapeErrors.length > 0) {
    return { manifest: null, errors: shapeErrors.map((message) => treeError(MANIFEST_FILE, message)) };
  }

  const known = new Set<string>();
  const names = manifest.modules.map((m) => m.name);
  if (names.some((name, i) => i > 0 && names[i - 1] >= name)) {
    errors.push(treeError(MANIFEST_FILE, 'modules must be unique and sorted by name'));
  }
  for (const entry of manifest.modules) {
    const where = `module "${entry.name}"`;
    const ascending = entry.versions.every((v, i) => i === 0 || compareSemver(entry.versions[i - 1], v) < 0);
    if (!ascending) errors.push(treeError(MANIFEST_FILE, `${where}: versions must be in ascending semver order`));
    if (entry.latestVersion !== maxSemver(entry.versions)) {
      errors.push(treeError(MANIFEST_FILE, `${where}: latestVersion must be the highest of versions`));
    }
    if (JSON.stringify(entry.versionDetails.map((d) => d.version)) !== JSON.stringify(entry.versions)) {
      errors.push(treeError(MANIFEST_FILE, `${where}: versionDetails must list the same versions as versions, in order`));
    }
    for (const details of entry.versionDetails) {
      const file = versionFilePath(entry.name, details.version);
      known.add(file);
      const text = tree.files.get(file);
      if (text === undefined) {
        errors.push(treeError(file, `listed in ${MANIFEST_FILE} but the file is missing`));
        continue;
      }
      if (sha256Hex(text) !== details.sha256) {
        errors.push(treeError(file, `sha256 does not match ${MANIFEST_FILE} (published files can never change)`));
        continue;
      }
      errors.push(...versionFileErrors(file, text, entry.name, details.version));
    }
  }
  for (const file of tree.files.keys()) {
    if (!known.has(file)) errors.push(treeError(file, `unexpected file; it is not listed in ${MANIFEST_FILE}`));
  }
  return { manifest, errors };
}

function versionFileErrors(file: string, text: string, moduleName: string, version: string): RegistryError[] {
  let parsed: { name?: string; versions?: { tag?: string }[] };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return [treeError(file, `is not valid JSON: ${(err as Error).message}`)];
  }
  const errors = schemaErrors('moduleVersion', parsed).map((message) => treeError(file, message));
  if (parsed.name !== moduleName) errors.push(treeError(file, `"name" must be "${moduleName}"`));
  if (parsed.versions?.[0]?.tag !== version) errors.push(treeError(file, `"versions[0].tag" must be "${version}"`));
  return errors;
}
