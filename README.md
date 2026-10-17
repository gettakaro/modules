# Takaro Modules - the Official Registry

This is the open-source (MIT) home of every Takaro-made module: Takaro's Official Registry.
Modules here are reviewed by the Takaro team. Learn more about Takaro at https://takaro.io and in the
docs at https://docs.takaro.io.

## Repository layout

| Path | Contents |
|------|----------|
| `modules/` | One directory per module: `module.json` plus `src/` |
| `src/` | TypeScript tooling to convert modules to and from Takaro's import format |
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

## Status

Publishing to the registry is being set up. Until then, modules are imported into a Takaro domain manually.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
