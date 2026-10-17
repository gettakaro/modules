import { RegistryManifest } from '../types/module.js';
import { RegistryError } from './errors.js';
import { MANIFEST_FILE, PublishedTree } from './tree.js';

function parseManifest(tree: PublishedTree): RegistryManifest | null {
  return tree.manifestText === null ? null : (JSON.parse(tree.manifestText) as RegistryManifest);
}

/**
 * Everything published at `base` must still be published, byte for byte, at `head`.
 * Catches hand edits to old version files that the source-versus-published rule cannot see.
 */
export function compareWithBase(base: PublishedTree, head: PublishedTree): RegistryError[] {
  const baseManifest = parseManifest(base);
  if (baseManifest === null) return [];

  const errors: RegistryError[] = [];
  for (const [file, baseText] of base.files) {
    const headText = head.files.get(file);
    if (headText === undefined) {
      errors.push({ path: `registry/${file}`, message: 'published version file was removed' });
    } else if (headText !== baseText) {
      errors.push({ path: `registry/${file}`, message: 'published version file was modified' });
    }
  }

  const headManifest = parseManifest(head);
  const headModules = new Map((headManifest?.modules ?? []).map((m) => [m.name, m]));
  for (const baseModule of baseManifest.modules) {
    const headModule = headModules.get(baseModule.name);
    if (!headModule) {
      errors.push({ path: `registry/${MANIFEST_FILE}`, message: `published module "${baseModule.name}" was removed` });
      continue;
    }
    for (const baseDetails of baseModule.versionDetails) {
      const headDetails = headModule.versionDetails.find((d) => d.version === baseDetails.version);
      if (!headDetails || !headModule.versions.includes(baseDetails.version)) {
        errors.push({
          path: `registry/${MANIFEST_FILE}`,
          message: `published version ${baseModule.name}@${baseDetails.version} was removed`,
        });
      } else if (JSON.stringify(headDetails) !== JSON.stringify(baseDetails)) {
        errors.push({
          path: `registry/${MANIFEST_FILE}`,
          message: `versionDetails of ${baseModule.name}@${baseDetails.version} changed (published entries are frozen)`,
        });
      }
    }
  }
  return errors;
}
