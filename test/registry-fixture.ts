import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const cliPath = path.join(repoRoot, 'dist', 'scripts', 'registry.js');
const fixtureDir = path.join(repoRoot, 'test', 'fixtures', 'registry');
export const expectedDir = path.join(fixtureDir, 'expected');

/** A fresh copy of the fixture source tree in a temp directory. */
export function copyFixtureSource(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-test-'));
  fs.cpSync(path.join(fixtureDir, 'source'), root, { recursive: true });
  return root;
}

export function readText(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8');
}

export function writeText(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

export function editJson(root: string, rel: string, mutate: (json: any) => void): void {
  const json = JSON.parse(readText(root, rel));
  mutate(json);
  writeText(root, rel, JSON.stringify(json, null, 2) + '\n');
}

export function editModuleJson(root: string, dir: string, mutate: (json: any) => void): void {
  editJson(root, `modules/${dir}/module.json`, mutate);
}

export function removeAll(root: string, rel: string): void {
  fs.rmSync(path.join(root, rel), { recursive: true, force: true });
}

/** Every file below `dir`, as relative path to content. */
export function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = fs.readFileSync(full, 'utf-8');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return files;
}
