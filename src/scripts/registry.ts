#!/usr/bin/env node
/**
 * Build or validate a module registry.
 * Usage: node dist/scripts/registry.js <build|check> [--root <dir>] [--base <git-ref>]
 *
 * build  Validate, then write new version files and registry.json below <root>/registry. Writes nothing on error.
 * check  Validate without writing. Fails when registry/ is out of date. With --base, also fails when anything
 *        published at <git-ref> was removed or changed.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { formatError } from '../registry/errors.js';
import { buildRegistry, checkRegistry } from '../registry/run.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { root: { type: 'string' }, base: { type: 'string' } },
});
const [command] = positionals;
const root = path.resolve(values.root ?? process.cwd());

function fail(errors: { path: string; message: string }[]): never {
  for (const error of errors) console.error(formatError(error));
  console.error(`\n${errors.length} error${errors.length === 1 ? '' : 's'}`);
  process.exit(1);
}

if (command === 'build') {
  const plan = buildRegistry(root);
  if (plan.errors.length > 0) fail(plan.errors);
  if (plan.added.length === 0) console.log('Nothing to add; registry/ is up to date.');
  for (const added of plan.added) console.log(`Added ${added}`);
} else if (command === 'check') {
  const errors = checkRegistry(root, values.base);
  if (errors.length > 0) fail(errors);
  console.log('Registry is valid.');
} else {
  console.error('Usage: registry.js <build|check> [--root <dir>] [--base <git-ref>]');
  process.exit(1);
}
