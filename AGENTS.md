# Takaro Modules - the Official Registry

This repository is the open-source (MIT) home of every Takaro-made module: Takaro's Official Registry.
Modules are reviewed by the Takaro team. See `README.md` for the layout and `CONTRIBUTING.md` for the contribution rules.

**Takaro Docs**: https://docs.takaro.io

## Quick Start

```bash
npm ci
npm run build   # required before shell scripts work
cp .env.example .env   # only needed to talk to a Takaro domain
bash scripts/takaro-auth.sh
```

## Commands

```bash
npm run build       # compile src/ to dist/
npm run typecheck
npm test            # offline checks, what CI runs
npm run test:live   # live suite against a Takaro domain; dormant, see test/README.md
npm run registry:build   # validate, then write new files below registry/
npm run registry:check   # validate without writing; CI runs this
```

## Registry conventions

Full spec: `docs/registry-format.md`.

- Listed modules have a kebab-case `name` equal to their directory name (no `test-` prefix) and a strict `x.y.z` `version`. Only the names in `legacyModuleNames` (`registry.config.json`) may be camelCase.
- `registry/` is generated and committed, and is append-only: a published version never changes. After changing a module, bump `version`, run `npm run registry:build` and commit `modules/` and `registry/` together. Never edit `registry/` by hand.
- Descriptions in `registry.json` are at most 500 characters: add a `summary` to `module.json` when the description is longer. `minTakaroVersion` is optional.
- Published modules are never removed. Add a module to `unlisted` in `registry.config.json` to stop publishing it.
- Merging to `main` deploys `registry/` and `schema/` to GitHub Pages.

## Module Development

All module development work is handled by the `takaro-module-dev` skill. This skill covers research, design, implementation, testing, and debugging of Takaro modules.

Modules live locally in `modules/` as editable files, then get pushed to a Takaro domain for testing via `scripts/module-push.sh`. Use `scripts/module-pull.sh` to pull existing modules down for editing.

**Note**: `scripts/module-push.sh` and `scripts/module-pull.sh` call compiled JS from `dist/`. Always run `npm run build` before using these scripts after any changes to `src/`.

### Testing Guidance

- When you have a Takaro domain, prefer checking behaviour through Takaro: the live suite (`npm run test:live`, see `test/README.md`) or in-game with the Minecraft dev environment in `dev/minecraft`.
- Pure helper logic may be unit tested offline. Example: `modules/daily-rewards/test/helpers.test.ts`.
- Do not use ad-hoc mocking hacks such as `globalThis.__mocks` or source-string replacement. Mocked tests pass while the real system fails.
- In-game verification is expected for behaviour changes when you have access to a Takaro domain and the Minecraft dev environment.

```bash
docker compose -f dev/minecraft/docker-compose.yml up -d paper bot
# Create a bot, trigger commands, verify execution events
# See the takaro-module-dev skill for detailed steps
```

**For verification agents**: The "app" here is a game server connected to Takaro. Use the bot service at `http://localhost:${BOT_PORT:-3101}` to exercise modules. See `references/bot-api.md` in the skill for the API. Check `dev/minecraft/.env` for the actual `BOT_PORT` value.

## Available Tools

- **`scripts/takaro-auth.sh`** - Authenticate with the Takaro API
- **`scripts/takaro-api.sh`** - Curl wrapper for Takaro API calls with auto-auth (supports `@file` for large bodies)
- **`scripts/module-push.sh`** - Push a local module to Takaro (`module-push.sh modules/<name>`)
- **`scripts/module-pull.sh`** - Pull a module from Takaro to local files (`module-pull.sh <name-or-id>`)
- **`npm run module:to-json`** - Convert local module dir to Takaro import JSON (calls compiled `dist/scripts/module-to-json.js`)
- **`npm run module:from-json`** - Convert Takaro export JSON to local module dir (calls compiled `dist/scripts/json-to-module.js`)
- **`dev/minecraft/download-plugin.sh`** - Download the Takaro Minecraft plugin
- **Bot service** (port `BOT_PORT`, default 3101) - Create and control Minecraft bots for testing
- **RCON** - `docker compose -f dev/minecraft/docker-compose.yml exec paper rcon-cli <command>`
