# Contributing

This repository is Takaro's Official Registry: the open-source home of every Takaro-made module.
**Every module here is reviewed by the Takaro team before it is merged.** Maintainers may ask for
changes, tests or in-game verification, and may decline modules that do not fit the official set.

Pull requests from forks are welcome. CI needs no secrets, so it runs on fork PRs.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE)
(inbound = outbound). There is no CLA.

## Getting started

```bash
git clone https://github.com/gettakaro/modules.git
cd modules
npm ci
npm run build
npm run typecheck
npm test
```

`npm test` runs offline checks only (see [test/README.md](test/README.md)); it is what CI runs.

## Module layout

Each module is one directory under `modules/`, containing a `module.json` and its code under
`src/**`. See [modules/README.md](modules/README.md). New module directories and names use kebab-case.

## Testing a module against your own Takaro domain

- Convert a module to Takaro's import format: `npm run module:to-json -- modules/<name> out.json`.
- Or push it straight to a domain with `scripts/module-push.sh modules/<name>` (configure `.env`
  from `.env.example`).
- Optionally verify behaviour in a real game with the Minecraft dev environment in
  [dev/minecraft](dev/minecraft/README.md).

Docs: https://docs.takaro.io

## Publishing

Publishing to the registry is being set up.
