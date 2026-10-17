# Tests

## Offline checks: `npm test`

Runs the `test/*.test.ts` files. Currently this checks that every module directory converts to
Takaro's import format. It needs no Takaro account and no secrets, and it is what CI runs.

## Live suite: `npm run test:live`

Runs `modules/*/test/*.test.ts`. These tests push modules to a real Takaro domain, install them on a
mock game server, and assert on real events. They need:

- a `.env` with Takaro credentials (see `.env.example`)
- Redis: `docker compose -f test/docker-compose.yml up -d`
- Takaro's mock game server package, which is not yet on public npm

The live suite therefore cannot run from a public checkout today and is not part of CI. It is kept
so it can return in a future live CI lane. The helpers it uses live in `test/helpers/`.
