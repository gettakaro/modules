import { execFileSync } from 'node:child_process';
import { emptyTree, MANIFEST_FILE, PublishedTree } from './tree.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
}

/** Load `registry/` as it is committed at `ref`. A ref without a registry/ directory yields an empty tree. */
export function loadTreeFromGit(root: string, ref: string): PublishedTree {
  const listing = git(root, ['ls-tree', '-r', '-z', '--name-only', ref, '--', 'registry/']);
  const tree = emptyTree();
  for (const repoPath of listing.split('\0').filter(Boolean)) {
    const rel = repoPath.slice('registry/'.length);
    const text = git(root, ['show', `${ref}:./${repoPath}`]);
    if (rel === MANIFEST_FILE) tree.manifestText = text;
    else tree.files.set(rel, text);
  }
  return tree;
}
