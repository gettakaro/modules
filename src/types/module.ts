/**
 * Shared type definitions for Takaro module structure.
 * Used by conversion scripts and test helpers.
 */

export interface CommandArgument {
  name: string;
  type: string;
  defaultValue?: string | null;
  helpText?: string;
  position?: number;
}

export interface ModuleCommand {
  name: string;
  trigger: string;
  description: string | null;
  helpText: string;
  function: string;
  arguments: CommandArgument[];
}

export interface ModuleHook {
  name: string;
  eventType: string;
  description: string | null;
  regex: string | null;
  function: string;
}

export interface ModuleCronJob {
  name: string;
  temporalValue: string;
  description: string | null;
  function: string;
}

export interface ModuleFunction {
  name: string;
  function: string;
}

export interface ModulePermission {
  permission: string;
  friendlyName: string;
  description: string;
  canHaveCount?: boolean;
}

export interface ModuleVersion {
  tag: string;
  description: string;
  configSchema: string;
  uiSchema: string;
  commands: ModuleCommand[];
  hooks: ModuleHook[];
  cronJobs: ModuleCronJob[];
  functions: ModuleFunction[];
  permissions: ModulePermission[];
  /** JSON string of the default system config */
  defaultSystemConfig?: string;
}

/** The format for importing/exporting a module to/from Takaro */
export interface TakaroModuleExport {
  takaroVersion: string;
  name: string;
  author: string;
  supportedGames: string[];
  versions: ModuleVersion[];
}

/** New consolidated module.json format — all metadata in one file */
export interface LocalCommandDef {
  trigger: string;
  description?: string | null;
  helpText?: string;
  function: string;
  arguments?: CommandArgument[];
}

export interface LocalHookDef {
  eventType: string;
  description?: string | null;
  regex?: string | null;
  function: string;
}

export interface LocalCronJobDef {
  temporalValue: string;
  description?: string | null;
  function: string;
}

export interface LocalFunctionDef {
  function: string;
}

export interface LocalModuleJson {
  name: string;
  author?: string;
  description?: string;
  version?: string;
  supportedGames?: string[];
  config?: Record<string, unknown>;
  uiSchema?: Record<string, unknown>;
  permissions?: ModulePermission[];
  commands?: Record<string, LocalCommandDef>;
  hooks?: Record<string, LocalHookDef>;
  cronJobs?: Record<string, LocalCronJobDef>;
  functions?: Record<string, LocalFunctionDef>;
  defaultSystemConfig?: Record<string, unknown>;
  /** Short manifest description, at most 500 characters. Used instead of `description` when present. */
  summary?: string;
  /** Lowest Takaro version (x.y.z) this module works with. */
  minTakaroVersion?: string;
}

export interface RegistryConfig {
  name: string;
  description?: string;
  /** Pre-existing camelCase names that are exempt from the kebab-case rule. */
  legacyModuleNames: string[];
  /** Module directory name -> reason it is not published. */
  unlisted: Record<string, string>;
}

export interface RegistryVersionDetails {
  version: string;
  /** Lowercase hex SHA-256 of the exact bytes of `<module>/<version>.json` as served. */
  sha256: string;
  minTakaroVersion?: string;
  /** Informational; Takaro derives its own. */
  requiredCapabilities: string[];
}

export interface RegistryModuleEntry {
  name: string;
  description: string;
  latestVersion: string;
  versions: string[];
  versionDetails: RegistryVersionDetails[];
}

export interface RegistryManifest {
  schemaVersion: 1;
  name: string;
  description?: string;
  modules: RegistryModuleEntry[];
}
