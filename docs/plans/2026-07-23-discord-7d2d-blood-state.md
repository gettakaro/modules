# Discord 7D2D Blood State Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Separate observed Blood Moon phase from Discord delivery history so private notices stay current and failed announcements retry without duplicates.

**Architecture:** Continue storing the observed phase in `discord7d2d:bloodState` for join-hook compatibility. Store up to 32 delivered announcement keys in `discord7d2d:bloodDelivered`; persist observation and migration before sending, then record each successful announcement immediately.

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
- For interval `1` at day 8 05:00, assert observed `today:8` and ordered completion of `end:7`, then `today:8`, once each.
- With the environment-provided forbidden Discord channel, assert the cron fails after persisting observed state, leaves the failed announcement pending, retries it, and the join hook can still PM from the current observed state.

**Step 3: Run RED**

Run the focused integration tests through the real Takaro API with Bearer/Authorization redaction. Expect failures because delivery history does not exist, observed state is currently written after Discord, and interval-one phase derivation returns `end:7` all day.

### Task 2: Implement separated state and delivery tracking

**Files:**
- Modify: `modules/discord-7d2d-status-bridge/src/cronjobs/blood-moon-monitor/index.js`
- Modify: `modules/discord-7d2d-status-bridge/src/functions/discord-7d2d-status-helpers.js`

**Step 1: Add delivered-history state**

Export `BLOOD_DELIVERED_KEY`. Normalize stored history to a unique string list capped at 32 entries.

**Step 2: Derive observation and announcements separately**

Return one observed key and an ordered list of announcement descriptors. Consecutive-day end overlap must yield `today:8` plus `end:7`, `today:8` at day 8 05:00.

**Step 3: Order persistence and delivery**

Read legacy state/history, persist observed state first, migrate any legacy announcement-shaped state before pending comparison, then send pending announcements in order. Persist each successful key immediately; do not record failures.

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
