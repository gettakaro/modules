/** The published tree (`registry/`) as plain data, loaded from a directory or from a git ref. */
export interface PublishedTree {
  /** Raw text of registry.json, or null when the tree has none. */
  manifestText: string | null;
  /** Every other file, keyed by posix path relative to registry/ (for example `afk-kick/1.0.0.json`). */
  files: Map<string, string>;
}

export const MANIFEST_FILE = 'registry.json';

export function emptyTree(): PublishedTree {
  return { manifestText: null, files: new Map() };
}

export function versionFilePath(moduleName: string, version: string): string {
  return `${moduleName}/${version}.json`;
}
