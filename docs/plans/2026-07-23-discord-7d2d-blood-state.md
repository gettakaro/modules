# Discord 7D2D Blood State Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Separate observed Blood Moon phase from Discord delivery history so private notices stay current and failed announcements retry without duplicates.

**Architecture:** Continue storing the observed phase in `discord7d2d:bloodState` for join-hook compatibility. Store up to 32 delivered keys in `discord7d2d:bloodDelivered` and 32 chronologically ordered retry keys in `discord7d2d:bloodPending`; persist observation, migration, and merged pending state before sending, then record each successful announcement before removing it from pending.

**Tech Stack:** JavaScript Takaro functions, TypeScript Node test runner, real Takaro API, Takaro WebSocket mock game server.

---

### Task 1: Prove state, retry, migration, and consecutive-day behavior

**Files:**
- Modify: `modules/discord-7d2d-status-bridge/test/bridge.test.ts`

**Step 1: Extend only the disposable imported schema**

Allow deterministic test commands such as `say Day 7 12:00` and `say Day 8 05:00` in the disposable module's `timeConsoleCommand` enum. Keep the production schema unchanged.

**Step 2: Write failing real-Takaro tests**

- Run a cron with a parseable day/time response and assert observed state plus delivered-history values.
- Seed a legacy announcement-shaped state with no delivered history and assert no duplicate current announcement.
- Assert real variable-operation logs persist migrated delivery history before overwriting observed state, then persist pending work before Discord.
- For interval `1` at day 8 05:00, assert observed `today:8` and ordered completion of `end:7`, then `today:8`, once each.
- Advance a failed `today:7` execution to `start:7` and assert both remain pending in chronological order.
- Trigger concurrent cron executions against absent variables and assert create conflicts recover without duplicate keys.
- Seed an expired monitor lock and assert it is reclaimed and released through the real variable API.
- Trigger concurrent cron executions with existing pending work and assert one waits for the scoped lock without losing any keys.
- Seed another active owner and assert acquisition backs off for the bounded interval, fails clearly, and preserves that owner's record.
- Hold an older queued execution across reinstall and assert it resolves the current installation config instead of writing stale state.
- Uninstall while a queued execution is held and assert the eventual 404 exits without state mutation while releasing the lock.
- With the environment-provided forbidden Discord channel, assert the cron fails after persisting observed state, leaves the failed announcement pending, retries it, and the join hook can still PM from the current observed state.

**Step 3: Run RED**

Run the focused integration tests through the real Takaro API with Bearer/Authorization redaction. Expect failures because delivery history does not exist, observed state is currently written after Discord, and interval-one phase derivation returns `end:7` all day.

### Task 2: Implement separated state and delivery tracking

**Files:**
- Modify: `modules/discord-7d2d-status-bridge/src/cronjobs/blood-moon-monitor/index.js`
- Modify: `modules/discord-7d2d-status-bridge/src/functions/discord-7d2d-status-helpers.js`

**Step 1: Add delivered-history state**

Export `BLOOD_DELIVERED_KEY` and `BLOOD_PENDING_KEY`. Normalize both stored lists to unique announcement keys capped at 32 entries.

**Step 2: Derive observation and announcements separately**

Return one observed key and an ordered list of announcement descriptors. Consecutive-day end overlap must yield `today:8` plus `end:7`, `today:8` at day 8 05:00.

**Step 3: Order persistence and delivery**

Acquire a scoped unique variable lock before reading game time or state. Use an owner token plus expiry, bounded polling with 50-250ms backoff, stale deletion by record ID, owner-checked renewal around external work and mutations, and owner-checked `finally` release. Keep the lease above Takaro's production function runtime bound. Fetch the current installation after lock acquisition so an older queued snapshot cannot apply stale user or system config; treat a 404 during an uninstall gap as a safe no-op. Read legacy state/history, derive and persist migrated delivery history before overwriting observed state, then merge and persist pending work before sending announcements in order. Persist each successful key before removing it from pending; keep failures and skips pending. Recover scoped variable create conflicts with a bounded re-search and backoff.

**Step 4: Run GREEN and refactor**

Run the focused state tests, then the complete module suite. Keep current cron timing and Discord diagnostics unchanged.

### Task 3: Verify and commit

**Files:**
- Verify: `modules/discord-7d2d-status-bridge/**`

**Step 1: Static verification**

Run `npm run build`, `npm run typecheck`, both changed JavaScript files through `node --check`, and `git diff --check`.

**Step 2: Focused integration verification**

Run the complete bridge integration suite with output redaction. Report any environment-gated Discord cases separately.

**Step 3: Commit**

Commit source and tests with a message describing reliable Blood Moon state tracking.
