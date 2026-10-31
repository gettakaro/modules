import fs from 'node:fs';
import path from 'node:path';
import {
  LocalModuleJson,
  ModuleCommand,
  ModuleCronJob,
  ModuleFunction,
  ModuleHook,
  ModuleShopAction,
  TakaroModuleExport,
  ModuleVersion,
} from '../types/module.js';
import { validateEntityName } from '../utils/validate.js';

export class ModuleSourceError extends Error {}

export const EMPTY_CONFIG_SCHEMA =
  '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{},"required":[],"additionalProperties":false}';

export function readModuleJson(moduleDir: string): LocalModuleJson {
  const moduleJsonPath = path.join(moduleDir, 'module.json');
  if (!fs.existsSync(moduleJsonPath)) {
    throw new ModuleSourceError(`${moduleJsonPath} not found`);
  }
  try {
    return JSON.parse(fs.readFileSync(moduleJsonPath, 'utf-8')) as LocalModuleJson;
  } catch (err) {
    throw new ModuleSourceError(`Failed to parse '${moduleJsonPath}': ${(err as Error).message}`);
  }
}

/** Read a JS file referenced from module.json. It must exist and stay inside the module directory, symlinks included. */
function readJsFile(moduleDir: string, relPath: string, label: string): string {
  const resolvedModuleDir = path.resolve(moduleDir);
  const absPath = path.resolve(resolvedModuleDir, relPath);
  if (!absPath.startsWith(resolvedModuleDir + path.sep) && absPath !== resolvedModuleDir) {
    throw new ModuleSourceError(`Path '${relPath}' escapes module directory (for ${label})`);
  }
  if (!fs.existsSync(absPath)) {
    throw new ModuleSourceError(`Referenced file '${relPath}' not found (for ${label}). Expected at ${absPath}`);
  }
  const realModuleDir = fs.realpathSync(resolvedModuleDir);
  const realAbsPath = fs.realpathSync(absPath);
  if (!realAbsPath.startsWith(realModuleDir + path.sep) && realAbsPath !== realModuleDir) {
    throw new ModuleSourceError(`Path '${relPath}' escapes module directory via symlink (for ${label})`);
  }
  return fs.readFileSync(realAbsPath, 'utf-8');
}

function checkName(name: string, type: string): void {
  try {
    validateEntityName(name, type);
  } catch (err) {
    throw new ModuleSourceError((err as Error).message);
  }
}

function requirePlainObject(moduleJsonPath: string, field: string, value: unknown): void {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw new ModuleSourceError(`'${moduleJsonPath}' field '${field}' must be a plain object (not a string or array)`);
  }
}

function entries<T>(record: Record<string, T> | undefined): [string, T][] {
  return record ? Object.entries(record) : [];
}

/** Convert a module directory (module.json plus the files it references) to Takaro's module export format. */
export function buildModuleExport(moduleDir: string): TakaroModuleExport {
  const moduleJsonPath = path.join(moduleDir, 'module.json');
  const mod = readModuleJson(moduleDir);

  checkName(mod.name ?? '', 'module');
  for (const field of ['commands', 'hooks', 'cronJobs', 'functions', 'shopActions', 'config', 'uiSchema'] as const) {
    requirePlainObject(moduleJsonPath, field, mod[field]);
  }

  const configSchema =
    mod.config && Object.keys(mod.config).length > 0 ? JSON.stringify(mod.config) : EMPTY_CONFIG_SCHEMA;
  const uiSchema = mod.uiSchema && Object.keys(mod.uiSchema).length > 0 ? JSON.stringify(mod.uiSchema) : '{}';

  const commands: ModuleCommand[] = entries(mod.commands).map(([name, def]) => {
    checkName(name, 'command');
    if (!def.function) {
      throw new ModuleSourceError(`command '${name}' is missing required field 'function' (path to JS file)`);
    }
    const command: ModuleCommand = {
      name,
      trigger: def.trigger ?? name,
      description: def.description ?? null,
      helpText: def.helpText ?? 'No help text available',
      function: readJsFile(moduleDir, def.function, `command '${name}'`),
      arguments: def.arguments ?? [],
    };
    if (def.requiredPermissions !== undefined) command.requiredPermissions = def.requiredPermissions;
    return command;
  });

  const hooks: ModuleHook[] = entries(mod.hooks).map(([name, def]) => {
    checkName(name, 'hook');
    if (!def.eventType) throw new ModuleSourceError(`hook '${name}' is missing required field 'eventType'`);
    if (!def.function) {
      throw new ModuleSourceError(`hook '${name}' is missing required field 'function' (path to JS file)`);
    }
    return {
      name,
      eventType: def.eventType,
      description: def.description ?? null,
      regex: def.regex ?? null,
      function: readJsFile(moduleDir, def.function, `hook '${name}'`),
    };
  });

  const cronJobs: ModuleCronJob[] = entries(mod.cronJobs).map(([name, def]) => {
    checkName(name, 'cronJob');
    if (!def.temporalValue) throw new ModuleSourceError(`cronJob '${name}' is missing required field 'temporalValue'`);
    if (!def.function) {
      throw new ModuleSourceError(`cronJob '${name}' is missing required field 'function' (path to JS file)`);
    }
    return {
      name,
      temporalValue: def.temporalValue,
      description: def.description ?? null,
      function: readJsFile(moduleDir, def.function, `cronJob '${name}'`),
    };
  });

  const functions: ModuleFunction[] = entries(mod.functions).map(([name, def]) => {
    checkName(name, 'function');
    if (!def.function) {
      throw new ModuleSourceError(`function '${name}' is missing required field 'function' (path to JS file)`);
    }
    return { name, function: readJsFile(moduleDir, def.function, `function '${name}'`) };
  });

  const version: ModuleVersion = {
    // A missing version still exports as 'latest' so drafts keep working; the validator rejects it for listed modules.
    tag: mod.version ?? 'latest',
    description: mod.description ?? 'No description',
    configSchema,
    uiSchema,
    commands,
    hooks,
    cronJobs,
    functions,
    permissions: mod.permissions ?? [],
  };
  // Conditional so versions published before shop actions existed keep their exact bytes.
  if (mod.shopActions !== undefined) {
    version.shopActions = entries(mod.shopActions).map(([name, def]): ModuleShopAction => {
      checkName(name, 'shopAction');
      if (!def.function) {
        throw new ModuleSourceError(`shopAction '${name}' is missing required field 'function' (path to JS file)`);
      }
      return {
        name,
        description: def.description ?? null,
        function: readJsFile(moduleDir, def.function, `shopAction '${name}'`),
      };
    });
  }
  if (mod.defaultSystemConfig !== undefined) {
    requirePlainObject(moduleJsonPath, 'defaultSystemConfig', mod.defaultSystemConfig);
    version.defaultSystemConfig = JSON.stringify(mod.defaultSystemConfig);
  }

  return {
    takaroVersion: '0.0.0',
    name: mod.name,
    author: mod.author ?? 'Unknown',
    supportedGames: mod.supportedGames ?? ['all'],
    versions: [version],
  };
}
