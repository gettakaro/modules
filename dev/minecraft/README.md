# Minecraft dev environment

An optional environment for testing modules in a real game: a Paper Minecraft server with the
Takaro plugin, plus an HTTP-controlled Mineflayer bot service that acts as a player. Use it to try
your modules against your own Takaro domain. It is not used by CI.

Requirements: Docker, and the [GitHub CLI](https://cli.github.com/) for the plugin download script.
Windows users should use WSL2 with Docker Desktop's WSL integration; if `localhost` does not reach
the containers, try `host.docker.internal`.

## Setup

All commands run from this directory.

```bash
cd dev/minecraft
cp .env.example .env
bash download-plugin.sh
```

1. In your Takaro dashboard go to **Game Servers** -> **Add Server** -> **Minecraft** and copy the
   registration token.
2. Put it in `.env` as `TAKARO_REGISTRATION_TOKEN`, and set `TAKARO_MC_IDENTITY_TOKEN` to something unique.
3. Start the services:
   ```bash
   docker compose up -d paper bot
   ```
4. Wait for Paper to finish starting (the first launch takes a few minutes):
   ```bash
   docker compose logs -f paper
   ```

## Running multiple instances

To run several clones side by side, set a unique `INSTANCE_ID` (0-9) and generate the port offsets:

```bash
./instance-env.sh 2 >> .env
```

| Instance | MC port | RCON port | Bot port |
|----------|---------|-----------|----------|
| 0 | 25665 | 25675 | 3101 |
| 1 | 25666 | 25676 | 3102 |
| 2 | 25667 | 25677 | 3103 |

Each clone also needs a unique `TAKARO_MC_IDENTITY_TOKEN`.

## Using the bot

The bot service listens on `BOT_PORT` (default 3101):

```bash
curl -X POST http://localhost:3101/bots \
  -H 'Content-Type: application/json' \
  -d '{"name": "player1"}'

curl http://localhost:3101/status

curl -X POST http://localhost:3101/bot/player1/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "+ping"}'

curl -X DELETE http://localhost:3101/bots/player1
```

Run console commands on the server with `docker compose exec paper rcon-cli <command>`.
