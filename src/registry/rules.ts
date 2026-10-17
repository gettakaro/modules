import { LocalModuleJson, RegistryConfig } from '../types/module.js';
import { isStrictSemver } from './semver.js';

export const RESERVED_NAMES = ['schema'];
export const MAX_NAME_LENGTH = 50;
export const MAX_VERSION_LENGTH = 20;
export const MAX_MANIFEST_DESCRIPTION_LENGTH = 500;

const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** The description shown in registry.json: the optional short summary, else the full description. */
export function manifestDescription(mod: LocalModuleJson): string {
  return mod.summary ?? mod.description ?? '';
}

/** Rules for a module that is published. Returns one message per violation. */
export function listedModuleErrors(dir: string, mod: LocalModuleJson, config: RegistryConfig): string[] {
  const errors: string[] = [];
  if (mod.name !== dir) {
    errors.push(`"name" is "${mod.name}" but must equal the directory name "${dir}"`);
  }
  if (!KEBAB_CASE.test(mod.name) && !config.legacyModuleNames.includes(mod.name)) {
    errors.push(`"name" "${mod.name}" must be kebab-case (lowercase letters, digits and single hyphens)`);
  }
  if (mod.name.length > MAX_NAME_LENGTH) {
    errors.push(`"name" must be at most ${MAX_NAME_LENGTH} characters`);
  }
  if (RESERVED_NAMES.includes(mod.name)) {
    errors.push(`"name" "${mod.name}" is reserved`);
  }
  if (mod.version === undefined || !isStrictSemver(mod.version) || mod.version.length > MAX_VERSION_LENGTH) {
    errors.push(
      `"version" must be a semantic version x.y.z of at most ${MAX_VERSION_LENGTH} characters, without pre-release or build metadata (got ${JSON.stringify(mod.version)})`,
    );
  }
  if (manifestDescription(mod).length > MAX_MANIFEST_DESCRIPTION_LENGTH) {
    errors.push(`description is longer than ${MAX_MANIFEST_DESCRIPTION_LENGTH} characters; add a \`summary\` (≤${MAX_MANIFEST_DESCRIPTION_LENGTH} chars)`);
  }
  return errors;
}

/** Duplicate argument names or positions inside one command. */
export function duplicateArgumentErrors(mod: LocalModuleJson): string[] {
  const errors: string[] = [];
  for (const [commandName, command] of Object.entries(mod.commands ?? {})) {
    const names = new Set<string>();
    const positions = new Set<number>();
    for (const argument of command.arguments ?? []) {
      if (names.has(argument.name)) {
        errors.push(`command "${commandName}" has more than one argument named "${argument.name}"`);
      }
      names.add(argument.name);
      if (argument.position !== undefined) {
        if (positions.has(argument.position)) {
          errors.push(`command "${commandName}" has more than one argument at position ${argument.position}`);
        }
        positions.add(argument.position);
      }
    }
  }
  return errors;
}
