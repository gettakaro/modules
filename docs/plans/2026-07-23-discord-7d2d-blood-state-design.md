# Discord 7D2D Blood State Design

## Goal

Keep the private first-player Blood Moon notice current even when Discord delivery fails, while retrying failed Discord announcements without duplicating successful ones.

## State model

- `discord7d2d:bloodState` stores only the currently observed phase used by the join hook.
- `discord7d2d:bloodDelivered` stores up to 32 unique announcement keys that Discord has actually accepted.
- `discord7d2d:bloodPending` stores up to 32 unique, chronologically ordered announcements that still need delivery.
- `discord7d2d:bloodMonitorLock` serializes the complete observation and delivery state machine per server and module.
- Announcement keys remain `today:<day>`, `start:<day>`, and `end:<day>` so legacy `bloodState` values can migrate without translation.

Each cron execution first derives and persists delivered history, including migration of any announcement-shaped legacy `bloodState`. Only after that migration is durable does it overwrite the observed phase used by the join hook. It then merges newly due announcements into pending state, persists the merged pending list, and processes it in order. This order prevents a crash after the observed-state write from making an unsent current announcement look like a delivered legacy announcement on the next run. Each successful announcement is recorded in delivered history before it is removed from pending state. A failed send or an unconfigured-channel skip remains pending across later phase and day transitions without repeating earlier successes.

Delivery is intentionally at least once across the external side-effect boundary: if Discord accepts a message and the function crashes before the delivered-history write completes, a later retry can duplicate that message. Discord does not provide an idempotency key for this send operation, so the module prefers a visible duplicate over permanently losing an announcement.

Before reading game time or any state, each cron atomically creates the scoped lock with a unique owner token and expiry. A competing execution uses bounded 50-250ms backoff and never enters the state machine until it owns the lock. Because Takaro's function VM does not expose timers, the backoff uses standard `Atomics.wait` rather than issuing artificial API traffic. The owner re-checks and renews its lease after status retrieval, after state reads, before each state mutation, and around every pending send. The 120-second lease is comfortably above Takaro's 30-second production function limit, while renewal also protects longer local executions. Expired or malformed locks are reclaimed by record ID, and `finally` releases only a lock whose current owner token still matches. Acquisition timeout and non-404 release failures remain visible execution failures. Ordinary variable creation also recovers from a create conflict by re-reading the same scoped key and updating the winning record after a small bounded backoff.

Takaro queue jobs contain an installation snapshot captured when they are enqueued. Reinstalling while an older job is queued cannot cancel that job, so after acquiring the lock the monitor fetches the current module installation and uses its current user and system config for time parsing, phase decisions, and channel resolution. A queued execution that outlives an uninstall receives a 404, exits without mutating state, and still releases its lock.

## Phase and announcement derivation

Observed state and announcements are separate outputs. For ordinary intervals, behavior remains today, start, and end at the existing boundaries. When consecutive days are Blood Moon days, the previous Blood Moon remains active until the configured end hour. At or after that boundary, the current observed state becomes `today:<current day>` and the cron can expose both `end:<previous day>` and `today:<current day>` as ordered announcements.

For interval `1`, day 8 at 05:00 therefore produces:

- observed state: `today:8`;
- announcements: `end:7`, then `today:8`.

## Migration

When the delivered-history variable does not exist, any legacy announcement-shaped `bloodState` value is recorded as delivered before current pending work is compared. The old implementation wrote that state only after successful or skipped delivery, so this prevents a current announcement from repeating immediately after upgrade. Normal and unknown legacy states do not imply a delivered announcement.

## Integration proof

The active WebSocket mock server has no configurable `gettime` response. The disposable test import will extend only its config schema to permit deterministic `say Day <n> <time>` commands. The production code will still execute through Takaro's real command API, and the real mock server returns a parseable `Sent message: Day ...` response. No helper methods, Takaro clients, or module source will be mocked.

Tests will prove migration-before-observation crash ordering, observed-state-before-pending/delivery behavior, retry bookkeeping, interval-one overlap, stale-lock recovery, bounded acquisition timeout that preserves another owner, current-config resolution for an older queued job, uninstall-gap handling, and concurrent serialization without lost pending keys through real Takaro variables and cron executions. The disposable import moves automatic Blood Moon scheduling to a valid dormant expression based on the prior UTC day, whose next occurrence is outside the test run, so every execution under test is explicitly triggered; the production manifest schedule is asserted separately. A configured forbidden Discord channel remains environment-gated.
