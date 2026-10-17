import fs from 'node:fs';
import { Ajv, ErrorObject, ValidateFunction } from 'ajv';

const SCHEMA_DIR = new URL('../../schema/', import.meta.url);

const ajv = new Ajv({ allErrors: true, strict: true });

function compile(file: string): ValidateFunction {
  return ajv.compile(JSON.parse(fs.readFileSync(new URL(file, SCHEMA_DIR), 'utf-8')));
}

const validators = {
  module: compile('module.schema.json'),
  registryConfig: compile('registry-config.schema.json'),
  registry: compile('registry.schema.json'),
  moduleVersion: compile('module-version.schema.json'),
};

export type SchemaName = keyof typeof validators;

function describeError(error: ErrorObject): string {
  const where = error.instancePath || '(root)';
  if (error.keyword === 'additionalProperties') {
    return `${where}: unknown property '${error.params.additionalProperty}'`;
  }
  return `${where}: ${error.message}`;
}

/** Returns a message per schema violation; empty when the value is valid. */
export function schemaErrors(schema: SchemaName, value: unknown): string[] {
  const validate = validators[schema];
  return validate(value) ? [] : (validate.errors ?? []).map(describeError);
}
