# Modules

Each subdirectory is one Takaro module:

- `module.json` - the module definition (name, config schema, commands, hooks, cron jobs, functions)
- `src/` - the JavaScript each command, hook, cron job and function points to
- `test/` - optional tests

`module.json` fields: `name`, `description`, `version`, `author`, `supportedGames`, `config`, `uiSchema`,
`permissions`, `commands`, `hooks`, `cronJobs`, `functions`, plus three optional fields:

- `defaultSystemConfig` - default system config of an installation
- `summary` - at most 500 characters; used as the registry description when `description` is longer
- `minTakaroVersion` - lowest Takaro version (`x.y.z`) the module works with

The full format is [schema/module.schema.json](../schema/module.schema.json). Naming, versioning and the release flow
are in [docs/registry-format.md](../docs/registry-format.md).

See [CONTRIBUTING.md](../CONTRIBUTING.md) for how to add or change a module.
