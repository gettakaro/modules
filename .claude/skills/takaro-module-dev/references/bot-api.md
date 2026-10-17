# Bot API Reference

The bot service provides an HTTP API for creating and controlling Minecraft player bots for testing. The port is configured by `BOT_PORT` in `dev/minecraft/.env` (default 3101).

**Base URL**: `http://localhost:${BOT_PORT:-3101}`

All POST endpoints require `Content-Type: application/json` header.

## Bot Management

### Create a bot
```
POST /bots
{"name": "tester"}
```
Returns: `{created: "tester", username: "Bot_tester"}`

Bot usernames follow the pattern `Bot_<name>`. The combined username must not exceed 16 characters (Minecraft limit), so bot names can be at most 12 characters.

### Destroy a bot
```
DELETE /bots/:name
```
Returns: `204 No Content`

### Status (all bots)
```
GET /status
```
Returns status of all active bots including: connected, name, username, health, food, position, gameMode. Returns `{}` when no bots exist.

### List all bots
```
GET /bots
```

## Per-Bot Actions

### Chat (send message or Takaro command)
```
POST /bot/:name/chat
{"message": "+ping"}
```
Use the correct command prefix (fetch from settings API — typically `+` or `/`).

### Move to coordinates
```
POST /bot/:name/move
{"x": 100, "y": 64, "z": 100}
```
Continuous forward motion for up to 30 seconds or until within 2 blocks of target.

### Attack nearest entity
```
POST /bot/:name/attack
```

### Interact with block in sight
```
POST /bot/:name/use
```
5 block range.

### Look at coordinates
```
POST /bot/:name/look
{"x": 100, "y": 64, "z": 100}
```

### Jump
```
POST /bot/:name/jump
```
0.5 second hold.

### Respawn (after death)
```
POST /bot/:name/respawn
```

## Per-Bot Queries

### Online players
```
GET /bot/:name/players
```
Returns: `[{username, uuid, ping, gamemode}, ...]`

### Position
```
GET /bot/:name/position
```
Returns: `{x, y, z}`

### Health
```
GET /bot/:name/health
```
Returns: `{health, food, saturation}`

### Inventory
```
GET /bot/:name/inventory
```
Returns: `[{name, count, slot, displayName}, ...]`

## Usage Example

```bash
# Create a bot
curl -X POST http://localhost:${BOT_PORT:-3101}/bots \
  -H 'Content-Type: application/json' \
  -d '{"name":"tester"}'

# Wait for connection
sleep 5
curl http://localhost:${BOT_PORT:-3101}/status

# Trigger a command
curl -X POST http://localhost:${BOT_PORT:-3101}/bot/tester/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"/greet World"}'

# Clean up
curl -X DELETE http://localhost:${BOT_PORT:-3101}/bots/tester
```

## Troubleshooting

- If a bot returns 503, the Minecraft server is likely still starting — wait and retry
- Bots auto-reconnect after server restarts with exponential backoff (5s to 60s)
- If the bot can't connect, check `docker compose -f dev/minecraft/docker-compose.yml logs bot` and `docker compose -f dev/minecraft/docker-compose.yml logs paper`
- For automated tests, prefer the mock game server approach (see `test/helpers/mock-server.ts`) which doesn't require a real Minecraft server
