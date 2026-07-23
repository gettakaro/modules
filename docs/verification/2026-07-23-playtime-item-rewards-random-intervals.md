# Playtime Item Rewards Random Interval Verification

Date: 2026-07-23

## Scope

This verification covers the persistent per-player random interval range added
to `playtime-item-rewards`, together with private reward delivery, accumulated
playtime across a disconnect, and same-cycle duplicate prevention.

The verified source commit was `f761b06`. Live verification used a temporary
module named `review-playtime-range-20260723` so the canonical module and shared
catalog entry were not replaced during the test.

## Automated verification

The focused real-Takaro integration suite passed with 3 tests passed, 0 failed,
and 1 explicit Paper-only skip. It proved:

- the editable maximum interval exists in the default and role-override schemas;
- a selected value in a 120-300 minute range is persisted across cron runs;
- a configured 300-minute minimum and 120-minute maximum normalizes safely to a
  fixed 300-minute interval.

The following checks also passed:

```bash
npm run build
npm run typecheck
node --check modules/playtime-item-rewards/src/functions/playtime-item-reward-helpers.js
node --check modules/playtime-item-rewards/src/cronjobs/grant-playtime-item-rewards/index.js
```

The test runner still emits the repository's unrelated local PostgreSQL
authentication warning. The suite uses the configured real Takaro API and
completed successfully.

## Paper environment

- Game server: `unique-mc-identity`
- Game server ID: `db94b768-740a-4625-a6cb-b62f7b21a5ca`
- Player: `Bot_priv23`
- Player ID: `933fec58-20e7-4766-861c-74b5918cc5a1`
- Game ID: `275cd8d4-aef4-355b-85df-5454019c4df0`
- Temporary module ID: `5d3592e6-60ab-400d-8489-d817de0b1cc7`
- Temporary version ID: `9768d6c6-4280-449a-994f-fd71f7d85517`
- Temporary cronjob ID: `d01f7f61-e8c5-45a8-a059-690ef03b7580`

Configuration:

```json
{
  "playtimeIntervalMinutes": 1,
  "playtimeIntervalMaximumMinutes": 2,
  "selectionMode": "single",
  "rewardMessage": "RANGECHECK {playerName} got {items} after {intervalMinutes}m",
  "messageDelivery": "private",
  "items": [
    {
      "name": "stone",
      "amount": 1,
      "quality": "",
      "dropChance": 100,
      "enabled": true
    }
  ],
  "roleOverrides": []
}
```

## Live results

Before connecting, Takaro held 204 seconds of accumulated playtime for the
offline player. This exceeded either possible first threshold in the configured
1-2 minute range.

Cron event `5bfea4c5-1b7b-4764-9f00-3f5267c81769` completed with
`success: true`. It granted one stone, increasing the bot inventory from one to
two stones, and sent this message:

```text
RANGECHECK Bot_priv23 got 1x stone after 1m
```

The Takaro action contained only the rewarded player's recipient:

```json
{
  "recipient": {
    "gameId": "275cd8d4-aef4-355b-85df-5454019c4df0"
  }
}
```

The bot client received the same private message. The `1m` value proves that
`{intervalMinutes}` renders the selected completed-cycle interval rather than a
range bound.

After completion, the persisted state selected a new two-minute interval and
stored its accumulated-playtime threshold:

```json
{
  "schedules": {
    "[\"default\",1,2]": {
      "intervalMinutes": 2,
      "eligibleAtPlaytimeSeconds": 324
    }
  },
  "claim": null,
  "lastOutcome": "granted"
}
```

Immediate repeat event `15d9bcfa-48fb-4e97-ae2f-a5285cb41d6b` completed with
`success: true`, `eligible 0`, and `granted 0`. The next schedule remained
exactly two minutes at threshold 324, proving that a cron rerun does not reroll
or duplicate the current cycle.

The bot then disconnected. Takaro advanced its accumulated playtime to 386
seconds while the reward schedule remained unchanged. After reconnecting the
same player, and before any new cron trigger, the schedule was still exactly two
minutes at threshold 324 and the inventory still contained two stones. This
proves that disconnect/reconnect does not reset or reroll the stored cycle.

## Cleanup

The temporary module installation and module were deleted, both test bot
processes were stopped, and Paper reported zero online players. A final Takaro
search returned no temporary module with either live-review name.
