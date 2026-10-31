# Takaro Modules - the Official Registry

This is the open-source (MIT) home of every Takaro-made module: Takaro's Official Registry.
Modules here are reviewed by the Takaro team. Learn more about Takaro at https://takaro.io and in the
docs at https://docs.takaro.io.

## Repository layout

| Path | Contents |
|------|----------|
| `modules/` | One directory per module: `module.json` plus `src/` |
| `src/` | TypeScript tooling: module conversion, and the registry build and validator |
| `registry/` | Generated and committed: `registry.json` and the append-only version files that GitHub Pages serves |
| `schema/` | JSON Schemas of the source and published formats, see [docs/registry-format.md](docs/registry-format.md) |
| `scripts/` | Shell helpers to authenticate against and push/pull modules to a Takaro domain |
| `test/` | Offline checks (run in CI) and the dormant live test suite, see [test/README.md](test/README.md) |
| `dev/minecraft/` | Optional Minecraft dev environment for in-game testing |
| `.claude/skills/` | Skills that guide AI agents such as Claude Code through module development |

## Quick start

```bash
git clone https://github.com/gettakaro/modules.git
cd modules
npm ci
npm run build
npm test
```

## Testing modules

`npm test` runs the offline checks. Module tests live next to each module in `modules/<name>/test/vm/` and run the
module code in Takaro's module VM against an in-memory fake, through
[`@takaro/module-test`](https://www.npmjs.com/package/@takaro/module-test). They need Node 24 or newer:

```bash
npm run test:modules
```

## Using a module with your Takaro domain

Convert a module to Takaro's import format and import it:

```bash
npm run module:to-json -- modules/hello-world out.json
```

Or push it directly. Copy `.env.example` to `.env`, fill in `TAKARO_HOST`, `TAKARO_USERNAME`,
`TAKARO_PASSWORD` and `TAKARO_DOMAIN_ID`, then:

```bash
bash scripts/module-push.sh modules/hello-world
```

## In-game testing

To try modules in a real game, see the optional [Minecraft dev environment](dev/minecraft/README.md).

## AI-assisted module development

The `takaro-module-dev` skill in `.claude/skills/` guides agents such as
[Claude Code](https://docs.anthropic.com/en/docs/claude-code/quickstart) through researching,
writing, pushing and testing a module. Windows users should run Claude Code inside WSL2.

```bash
claude
> Write me a module that says 'hello' to every player when they join
```

## Subscribing

In Takaro, subscribe a domain to `https://gettakaro.github.io/modules` and install modules from there. A custom
domain, `registry.takaro.io`, will follow.

The modules Takaro used to bundle are published here under their existing camelCase names. Each `1.0.0` holds the
same content as the last version Takaro bundled, except that teleports' `teleportwaypoint` finds the teleports module
by name instead of the built-in flag:

- `chatBridge`
- `dailyRewards`
- `economyUtils`
- `geoBlock`
- `gimme`
- `highPingKicker`
- `lottery`
- `playerOnboarding`
- `serverMessages`
- `shopActions`
- `teleports`
- `timedShutdown`
- `utils`

The other published modules are:

- `afk-kick`
- `community-fund`
- `discord-status-bridge-7d2d`
- `kill-tracker`
- `mini-games`
- `playtime-buff-rewards`
- `referral-program`
- `server-toolkit`
- `vote-restart`
- `zombie-racing`

Every version is immutable and has a SHA-256 in `registry.json`. The file formats are documented in
[docs/registry-format.md](docs/registry-format.md).

## Run your own registry

1. Copy this repo.
2. Edit `registry.config.json`: set `name` and `description`, empty `legacyModuleNames`, and adjust `unlisted`.
3. Replace `modules/` with your modules and delete `registry/`.
4. Run `npm run registry:build` and commit the result.
5. Enable GitHub Pages for your repo: `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow`.
6. Subscribe to `https://<owner>.github.io/<repo>`.

The validator can check another checkout too: `node dist/scripts/registry.js check --root <dir>`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
