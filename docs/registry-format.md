# Registry format

This repository is a Takaro module registry. A build turns the module sources under `modules/` into a published tree
under `registry/`, and GitHub Pages serves that tree. Takaro subscribes to the base URL and reads the files described
here.

Machine-readable versions of every format are in [`schema/`](../schema) (JSON Schema draft-07) and are published next
to the registry:

| File | Describes |
|------|-----------|
| [`module.schema.json`](../schema/module.schema.json) | the source `modules/<dir>/module.json` |
| [`registry-config.schema.json`](../schema/registry-config.schema.json) | the root `registry.config.json` |
| [`registry.schema.json`](../schema/registry.schema.json) | the published `registry.json` |
| [`module-version.schema.json`](../schema/module-version.schema.json) | a published `<module>/<version>.json` |

Published at `https://gettakaro.github.io/modules/schema/<file>`.

## Source layout

```
registry.config.json
modules/
  <dir>/
    module.json          the module definition
    src/**               JavaScript referenced from module.json
    test/                optional tests
registry/                generated, committed, append-only (see below)
schema/                  JSON Schemas
```

`module.json` fields:

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | yes | Module name. For listed modules it equals the directory name. |
| `description` | yes | Full description, kept in the version file. |
| `version` | listed modules | Semantic version `x.y.z`. |
| `author` | no | Defaults to `Unknown`. |
| `summary` | no | At most 500 characters. Used as the `registry.json` description. |
| `minTakaroVersion` | no | `x.y.z`. Copied into `versionDetails` when the version is first published. |
| `supportedGames` | no | Defaults to `["all"]`. |
| `config`, `uiSchema` | no | JSON schema and UI schema of the module configuration. |
| `defaultSystemConfig` | no | Default system config of an installation. |
| `permissions`, `commands`, `hooks`, `cronJobs`, `functions`, `shopActions` | no | The module's components. Function paths are relative to the module directory and must stay inside it. |

A command may list `requiredPermissions`: permission keys a player must hold before Takaro runs it. `shopActions` is
an object keyed by action name, each entry `{ "description"?: string | null, "function": "<path>" }`; a shop listing
can run one when a player buys it.

Unknown keys are refused, so a typo cannot silently be dropped.

## `registry.config.json`

```json
{
  "name": "Takaro Official Registry",
  "description": "Modules made and reviewed by the Takaro team.",
  "legacyModuleNames": ["utils", "teleports"],
  "unlisted": { "hello-world": "Example module for module authors" }
}
```

- `name` (1-200 characters) and `description` (at most 1000) are copied into `registry.json`.
- `unlisted` maps a **directory name** to the reason that module is not published. Unlisted modules are only checked
  against `module.schema.json`; their name and version are free-form.
- `legacyModuleNames` lists camelCase names that are exempt from the naming rule. It is a fixed exception for Takaro's
  formerly bundled modules. A new registry leaves it empty.

## Published layout

Served at the Pages root:

```
registry.json
<module>/<version>.json      one per published version, never modified or deleted
schema/*.schema.json
```

The URL of a version file is `<base>/<module>/<version>.json`. Module names and versions never need escaping.

## `registry.json`

```json
{
  "schemaVersion": 1,
  "name": "Takaro Official Registry",
  "description": "Modules made and reviewed by the Takaro team.",
  "modules": [
    {
      "name": "afk-kick",
      "description": "AFK Kick, periodically checks player positions and warns or kicks idle players.",
      "latestVersion": "1.0.0",
      "versions": ["1.0.0"],
      "versionDetails": [
        {
          "version": "1.0.0",
          "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "minTakaroVersion": "1.2.3",
          "requiredCapabilities": ["chat.send", "moderation.kick"]
        }
      ]
    }
  ]
}
```

- `modules` are sorted by name, `versions` are in ascending semver order, and `latestVersion` is the highest entry.
- `versions` stays a list of strings so that every Takaro release that reads the registry keeps working. Per-version
  data lives in the sibling `versionDetails` array, one entry per version in the same order. Readers that do not know
  `versionDetails` ignore it.
- The module `description` is at most 500 characters: the module's `summary` when it has one, else its `description`.
- `sha256` is the lowercase hex SHA-256 of the **exact bytes of the version file as served** (UTF-8, no BOM). Hash the
  raw response body. Never hash re-serialized JSON.
- `minTakaroVersion` is omitted when the module does not declare one. It is never `null`.
- `requiredCapabilities` is always present, sorted and unique, and may be empty. It is derived from the code and is
  informational: Takaro derives its own.
- A `versionDetails` entry is frozen once published. The build copies existing entries forward unchanged and only
  computes entries for new versions.

## Version files

`<module>/<version>.json` is Takaro's module export format, with exactly one entry in `versions`. Its `tag` is the
semantic version, and `defaultSystemConfig` (a JSON string) is present when the module declares one. A command
carries `requiredPermissions` and the version carries `shopActions` (`name`, `description`, code) only when the module
declares at least one, so files published before those keys existed keep their bytes.

The files are written as `JSON.stringify(value, null, 2)` plus a trailing newline, with keys in a fixed order. A
change to the serializer or to the export format therefore changes the bytes of a module's current version. That is
an append-only violation, and the module needs a version bump.

## Rules

Everything the validator checks, in one place. All errors are listed together as `<path>: <message>`.

For every module directory:

- `module.json` is valid against `module.schema.json`.
- Every referenced function file exists and stays inside the module directory, also through symlinks.
- A command has no two arguments with the same `name` or `position`.

For every listed module (every directory not in `unlisted`):

- `name` equals the directory name.
- `name` is kebab-case (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`) of at most 50 characters and is not `schema`, **or** it is in
  `legacyModuleNames`.
- `version` is `x.y.z`: no pre-release, no build metadata, no leading zeros, at most 20 characters.
- The description in `registry.json` (`summary`, else `description`) is at most 500 characters.

Append-only, against `registry/`:

- A source version that is already published must reproduce the published file byte for byte, and must declare the
  same `minTakaroVersion`. Otherwise: `<name>@<version> is already published and its content changed; bump "version"`.
- A new version must be greater than every published version of that module.
- Published modules whose source is gone, or that became unlisted, stay in `registry.json` unchanged. Nothing is ever
  removed.
- Every listed version has a file, every file is listed, and every file matches its `sha256`. Nothing else is in
  `registry/`.
- `registry/` is what the build would write. Otherwise: `registry/ is out of date`.

With `--base <git-ref>`, the validator also loads `registry/` as committed at that ref and fails if any file, module,
version or `versionDetails` entry published there was removed or changed. This catches hand edits to old versions.

## Release flow

1. Change the module.
2. Bump `version` in `module.json`.
3. Run `npm run registry:build`.
4. Commit `modules/` and `registry/` together.

CI runs `npm run registry:check -- --base origin/main` on every pull request. Merging to `main` publishes the
committed `registry/` and `schema/` to GitHub Pages. CI never builds or commits the registry itself.
Merging to `main` also asks the Takaro monorepo to open a snapshot bump PR.

## Commands

```bash
npm run registry:build                                   # validate, then write new files below registry/
npm run registry:check                                   # validate, write nothing
npm run registry:check -- --base origin/main             # also compare with what main published
node dist/scripts/registry.js check --root ../other-repo # validate another checkout
```

`build` is all or nothing: on any error it writes nothing and exits 1.

## Run your own registry

1. Copy this repository (the GitHub "Use this template" flow works if the repository is marked as a template).
2. Edit `registry.config.json`: set the name and description, empty `legacyModuleNames` and adjust `unlisted`.
3. Replace `modules/` with your modules and delete `registry/`.
4. Run `npm run registry:build` and commit the result.
5. Enable GitHub Pages with the build source "GitHub Actions":
   `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow`.
6. Push to `main`. The `Publish registry` workflow deploys the site.
7. Subscribe a Takaro domain to `https://<owner>.github.io/<repo>`.

Takaro does not follow redirects when it fetches `registry.json`. If you later add a custom domain to Pages, the
`github.io` URL starts redirecting and subscriptions must move to the custom domain.
