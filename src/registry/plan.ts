import {
  LocalModuleJson,
  RegistryConfig,
  RegistryManifest,
  RegistryModuleEntry,
  RegistryVersionDetails,
  TakaroModuleExport,
} from '../types/module.js';
import { deriveRequiredCapabilities } from './capabilities.js';
import { RegistryError } from './errors.js';
import { checkPublishedTree } from './published.js';
import { duplicateArgumentErrors, listedModuleErrors, manifestDescription } from './rules.js';
import { schemaErrors } from './schema.js';
import { compareSemver, maxSemver } from './semver.js';
import { canonicalJson, sha256Hex } from './serialize.js';
import { MANIFEST_FILE, PublishedTree, versionFilePath } from './tree.js';

/** One directory under modules/, as loaded from disk. */
export interface ModuleSource {
  dir: string;
  /** Parsed module.json, unvalidated. */
  json?: unknown;
  /** The module.json could not be read or parsed. */
  loadError?: string;
  /** The export built from the directory, when it could be built. */
  export?: TakaroModuleExport;
  /** Why the export could not be built (missing function file, path escape, ...). */
  exportError?: string;
}

export interface RegistryPlan {
  errors: RegistryError[];
  /** Files (relative to registry/) whose content would change, including registry.json. */
  writes: Map<string, string>;
  /** `name@version` of every version the build would add. */
  added: string[];
}

interface ListedModule {
  dir: string;
  json: LocalModuleJson;
  versionFile: string;
  details: RegistryVersionDetails;
}

function normalizeConfig(config: Partial<RegistryConfig> & { name: string }): RegistryConfig {
  return { legacyModuleNames: [], unlisted: {}, ...config };
}

function moduleJsonPath(dir: string): string {
  return `modules/${dir}/module.json`;
}

function newVersionDetails(json: LocalModuleJson, versionFile: string, exported: TakaroModuleExport): RegistryVersionDetails {
  const details: RegistryVersionDetails = {
    version: json.version as string,
    sha256: sha256Hex(versionFile),
    requiredCapabilities: deriveRequiredCapabilities(exported.versions[0]),
  };
  if (json.minTakaroVersion !== undefined) details.minTakaroVersion = json.minTakaroVersion;
  return details;
}

/** Validate the sources on their own and return the modules that will be published. */
function checkSources(
  config: RegistryConfig,
  sources: ModuleSource[],
  errors: RegistryError[],
): ListedModule[] {
  const dirs = new Set(sources.map((s) => s.dir));
  for (const dir of Object.keys(config.unlisted)) {
    if (!dirs.has(dir)) {
      errors.push({ path: 'registry.config.json', message: `"unlisted" names "${dir}" but modules/${dir} does not exist` });
    }
  }

  const listed: ListedModule[] = [];
  for (const source of sources) {
    const path = moduleJsonPath(source.dir);
    if (source.loadError) {
      errors.push({ path, message: source.loadError });
      continue;
    }
    const problems = schemaErrors('module', source.json);
    if (problems.length > 0) {
      errors.push(...problems.map((message) => ({ path, message })));
      continue;
    }
    const json = source.json as LocalModuleJson;
    const moduleErrors = duplicateArgumentErrors(json);
    if (source.exportError) moduleErrors.push(source.exportError);
    if (!(source.dir in config.unlisted)) moduleErrors.push(...listedModuleErrors(source.dir, json, config));
    if (moduleErrors.length > 0) {
      errors.push(...moduleErrors.map((message) => ({ path, message })));
      continue;
    }
    if (source.dir in config.unlisted) continue;

    const versionFile = canonicalJson(source.export);
    listed.push({
      dir: source.dir,
      json,
      versionFile,
      details: newVersionDetails(json, versionFile, source.export as TakaroModuleExport),
    });
  }
  return listed;
}

/**
 * Decide what the build would publish.
 *
 * Pure: no filesystem, no git. The published tree is the history, the sources are the proposal. A source whose
 * version is already published must reproduce the published bytes; a new version must be higher than all published
 * ones. Nothing published is ever changed or removed.
 */
export function planRegistry(input: {
  config: unknown;
  sources: ModuleSource[];
  published: PublishedTree;
}): RegistryPlan {
  const plan: RegistryPlan = { errors: [], writes: new Map(), added: [] };

  const configProblems = schemaErrors('registryConfig', input.config);
  if (configProblems.length > 0) {
    plan.errors.push(...configProblems.map((message) => ({ path: 'registry.config.json', message })));
    return plan;
  }
  const config = normalizeConfig(input.config as RegistryConfig);

  const listed = checkSources(config, input.sources, plan.errors);
  const publishedTree = checkPublishedTree(input.published);
  plan.errors.push(...publishedTree.errors);
  if (plan.errors.length > 0) return plan;

  const publishedModules = new Map((publishedTree.manifest?.modules ?? []).map((m) => [m.name, m]));
  const entries = new Map<string, RegistryModuleEntry>(
    [...publishedModules].map(([name, entry]) => [name, structuredClone(entry)]),
  );
  const newFiles = new Map<string, string>();

  for (const module of listed) {
    const name = module.json.name;
    const version = module.json.version as string;
    const existing = entries.get(name);

    if (existing && existing.versions.includes(version)) {
      const frozen = existing.versionDetails.find((d) => d.version === version) as RegistryVersionDetails;
      const publishedText = input.published.files.get(versionFilePath(name, version));
      if (publishedText !== module.versionFile || frozen.minTakaroVersion !== module.details.minTakaroVersion) {
        plan.errors.push({
          path: moduleJsonPath(module.dir),
          message: `${name}@${version} is already published and its content changed; bump "version" in modules/${module.dir}/module.json`,
        });
      }
      existing.description = manifestDescription(module.json);
      continue;
    }

    if (existing) {
      const latest = maxSemver(existing.versions);
      if (compareSemver(version, latest) <= 0) {
        plan.errors.push({
          path: moduleJsonPath(module.dir),
          message: `${name}@${version} must be greater than the latest published version ${latest}`,
        });
        continue;
      }
      existing.versions.push(version);
      existing.versionDetails.push(module.details);
      existing.latestVersion = version;
      existing.description = manifestDescription(module.json);
    } else {
      entries.set(name, {
        name,
        description: manifestDescription(module.json),
        latestVersion: version,
        versions: [version],
        versionDetails: [module.details],
      });
    }
    newFiles.set(versionFilePath(name, version), module.versionFile);
    plan.added.push(`${name}@${version}`);
  }
  if (plan.errors.length > 0) return plan;

  const manifest: RegistryManifest = {
    schemaVersion: 1,
    name: config.name,
    ...(config.description !== undefined && { description: config.description }),
    modules: [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
  const manifestText = canonicalJson(manifest);

  const outputErrors: RegistryError[] = [
    ...schemaErrors('registry', manifest).map((message) => ({ path: `registry/${MANIFEST_FILE}`, message })),
    ...[...newFiles].flatMap(([file, text]) =>
      schemaErrors('moduleVersion', JSON.parse(text)).map((message) => ({ path: `registry/${file}`, message })),
    ),
  ];
  if (outputErrors.length > 0) {
    plan.errors.push(...outputErrors);
    return plan;
  }

  for (const [file, text] of newFiles) plan.writes.set(file, text);
  if (manifestText !== input.published.manifestText) plan.writes.set(MANIFEST_FILE, manifestText);
  return plan;
}
