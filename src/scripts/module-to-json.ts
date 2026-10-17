#!/usr/bin/env node
/**
 * Convert a local module directory (with consolidated module.json) into the Takaro import JSON format.
 * Usage: node dist/scripts/module-to-json.js <module-dir> [output-file]
 */
import fs from 'fs';
import { buildModuleExport, ModuleSourceError } from '../registry/export.js';

const moduleDir = process.argv[2];
const outputFile = process.argv[3];

if (!moduleDir) {
  console.error('Usage: module-to-json.js <module-dir> [output-file]');
  process.exit(1);
}

if (!fs.existsSync(moduleDir) || !fs.statSync(moduleDir).isDirectory()) {
  console.error(`ERROR: ${moduleDir} is not a directory`);
  process.exit(1);
}

let json: string;
try {
  json = JSON.stringify(buildModuleExport(moduleDir), null, 2);
} catch (err) {
  if (!(err instanceof ModuleSourceError)) throw err;
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}

if (outputFile) {
  fs.writeFileSync(outputFile, json);
  console.error(`Written to ${outputFile}`);
} else {
  console.log(json);
}
