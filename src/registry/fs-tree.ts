import fs from 'node:fs';
import path from 'node:path';
import { emptyTree, MANIFEST_FILE, PublishedTree } from './tree.js';

function listFiles(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) return listFiles(path.join(dir, entry.name), rel + '/');
    if (entry.isFile()) return [rel];
    throw new Error(`${path.join(dir, entry.name)} is not a regular file or directory`);
  });
}

export function loadTreeFromDirectory(registryDir: string): PublishedTree {
  if (!fs.existsSync(registryDir)) return emptyTree();
  const tree = emptyTree();
  for (const rel of listFiles(registryDir)) {
    const text = fs.readFileSync(path.join(registryDir, rel), 'utf-8');
    if (rel === MANIFEST_FILE) tree.manifestText = text;
    else tree.files.set(rel, text);
  }
  return tree;
}

/** Write files below registry/, creating directories. Only called with a complete, valid plan. */
export function writeTree(registryDir: string, writes: Map<string, string>): void {
  for (const [rel, text] of writes) {
    const target = path.join(registryDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, 'utf-8');
  }
}
