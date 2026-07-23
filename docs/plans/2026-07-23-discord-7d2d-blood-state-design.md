# Discord 7D2D Blood State Design

## Goal

Keep the private first-player Blood Moon notice current even when Discord delivery fails, while retrying failed Discord announcements without duplicating successful ones.

## State model

- `discord7d2d:bloodState` stores only the currently observed phase used by the join hook.
- `discord7d2d:bloodDelivered` stores up to 32 unique announcement keys that Discord has accepted, or that the existing empty-channel skip path has completed.
- Announcement keys remain `today:<day>`, `start:<day>`, and `end:<day>` so legacy `bloodState` values can migrate without translation.

Each cron execution persists the observed phase before attempting Discord. It then migrates any announcement-shaped legacy `bloodState` value into delivered history, derives pending announcements, and processes them in order. Each successful announcement is recorded immediately. A failed send is not recorded, so the next cron retries it without repeating earlier successes.

## Phase and announcement derivation

Observed state and announcements are separate outputs. For ordinary intervals, behavior remains today, start, and end at the existing boundaries. When consecutive days are Blood Moon days, the previous Blood Moon remains active until the configured end hour. At or after that boundary, the current observed state becomes `today:<current day>` and the cron can expose both `end:<previous day>` and `today:<current day>` as ordered announcements.

For interval `1`, day 8 at 05:00 therefore produces:

- observed state: `today:8`;
- announcements: `end:7`, then `today:8`.

## Migration

When the delivered-history variable does not exist, any legacy announcement-shaped `bloodState` value is recorded as delivered before current pending work is compared. The old implementation wrote that state only after successful or skipped delivery, so this prevents a current announcement from repeating immediately after upgrade. Normal and unknown legacy states do not imply a delivered announcement.

## Integration proof

The active WebSocket mock server has no configurable `gettime` response. The disposable test import will extend only its config schema to permit deterministic `say Day <n> <time>` commands. The production code will still execute through Takaro's real command API, and the real mock server returns a parseable `Sent message: Day ...` response. No helper methods, Takaro clients, or module source will be mocked.

Tests will prove observed-state-first behavior, retry bookkeeping, migration, and interval-one overlap through real Takaro variables and cron executions. A configured forbidden Discord channel remains environment-gated.
