# Discord 7D2D Monitoring Feedback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Discord monitoring failures actionable, prove real outbound delivery, detect Blood Moon transitions every minute, and optionally privately notify the first joining player on a Blood Moon day.

**Architecture:** Keep Takaro's channel-ID Discord API and add error normalization in the shared helper. Persist the Blood Moon phase from the one-minute monitor and let the join hook read that phase plus the online-player count, avoiding an extra `gettime` call on every join. All automated coverage continues to import/install/execute through the real Takaro API.

**Tech Stack:** JavaScript Takaro functions, TypeScript Node test runner, `@takaro/apiclient`, Takaro mock game server, Paper bot service, Discord API through Takaro.

---

### Task 1: Establish an honest focused baseline

**Files:**
- Test: `modules/discord-7d2d-status-bridge/test/bridge.test.ts`

**Step 1: Reuse repository-local runtime configuration**

Link the main checkout's ignored `.env` and installed `node_modules` into the isolated worktree. Do not print credential values.

**Step 2: Build the current branch**

Run: `npm run build`

Expected: TypeScript build succeeds.

**Step 3: Run the current focused integration suite**

Run: `T_WS_CONTINUOUS_RECONNECT=false T_WS_HEARTBEAT_INTERVAL_MS=120000 LOGGING_LEVEL=warn node --test-force-exit --test-concurrency 1 --import=ts-node-maintained/register/esm --test modules/discord-7d2d-status-bridge/test/bridge.test.ts`

Expected: Existing tests pass or any infrastructure failure is recorded before feature work.

### Task 2: Replace Discord skip-path false positives with real delivery evidence

**Files:**
- Modify: `modules/discord-7d2d-status-bridge/test/bridge.test.ts`
- Modify: `modules/discord-7d2d-status-bridge/src/functions/discord-7d2d-status-helpers.js`

**Step 1: Write the failing real-delivery assertions**

Add an optional `TAKARO_DISCORD_TEST_CHANNEL_ID` test path that installs the disposable module with that monitoring channel, triggers `updateStatus`, and requires both:

```ts
assertLogContains(logs, `/discord/channels/${channelId}/message 200 OK`);
assert.ok(!logs.some((message) => message.includes('skipped message:')));
```

Add a failed-execution helper so a configured inaccessible channel can assert `success: false` and inspect logs rather than failing inside the test harness first.

**Step 2: Run the focused test and verify RED against the reported channel**

Run the focused command with `TAKARO_DISCORD_FORBIDDEN_CHANNEL_ID` set from the user's reported execution context.

Expected: FAIL because the current logs end in generic `403 Forbidden` without actionable channel guidance.

**Step 3: Implement minimal Discord error normalization**

Wrap the real API call in `sendDiscord` and derive `status`, Takaro error code, and Discord error code from the Axios response without logging tokens or headers. For 403, throw an error containing:

```text
Discord channel <id> is forbidden. Use a normal text channel and grant the Takaro bot View Channel, Send Messages, and Read Message History; private or archived threads may still reject the bot.
```

Preserve the original error as `cause`. Do not fall back to the chat channel.

Apply the same normalization when updating the persistent message; if update fails, retain the existing replacement-send behavior and emit the normalized reason.

**Step 4: Re-run and verify GREEN**

Expected: the inaccessible-channel execution fails with the actionable diagnostic, and the configured QA channel records a real HTTP 200.

**Step 5: Commit**

```bash
git add modules/discord-7d2d-status-bridge/test/bridge.test.ts modules/discord-7d2d-status-bridge/src/functions/discord-7d2d-status-helpers.js
git commit -m "fix: diagnose Discord monitoring delivery"
```

### Task 3: Detect Blood Moon phase transitions every minute

**Files:**
- Modify: `modules/discord-7d2d-status-bridge/test/bridge.test.ts`
- Modify: `modules/discord-7d2d-status-bridge/module.json`

**Step 1: Write the failing imported-module assertion**

After importing the disposable module, find `bloodMoonMonitor` in `mod.latestVersion.cronJobs` and assert:

```ts
assert.equal(bloodMoonCron.temporalValue, '* * * * *');
```

Also assert `updateStatus` remains `*/5 * * * *`.

**Step 2: Run and verify RED**

Expected: FAIL with actual `*/5 * * * *` for `bloodMoonMonitor`.

**Step 3: Implement the schedule change**

Change only `bloodMoonMonitor.temporalValue` to `* * * * *` and update its description to state that phase transitions are checked every minute. Keep state-key duplicate suppression unchanged.

**Step 4: Re-run and verify GREEN**

Expected: schedule assertion passes and existing Blood Moon execution behavior remains green.

**Step 5: Commit**

```bash
git add modules/discord-7d2d-status-bridge/module.json modules/discord-7d2d-status-bridge/test/bridge.test.ts
git commit -m "fix: check blood moon phases every minute"
```

### Task 4: Privately notify the first joining player

**Files:**
- Modify: `modules/discord-7d2d-status-bridge/test/bridge.test.ts`
- Modify: `modules/discord-7d2d-status-bridge/module.json`
- Modify: `modules/discord-7d2d-status-bridge/src/functions/discord-7d2d-status-helpers.js`
- Modify: `modules/discord-7d2d-status-bridge/src/hooks/monitor-join/index.js`

**Step 1: Write failing real-Takaro tests**

Add config-schema assertions for:

```json
"privateBloodMoonNoticeOnFirstJoin": { "type": "boolean", "default": false }
"privateBloodMoonTodayMessage": { "type": "string", "maxLength": 500, "default": "" }
```

Using a one-player disposable mock server and a real Takaro variable record with key `discord7d2d:bloodState` and JSON value `"today:7"`, trigger `player-connected` with the option enabled. Require a successful `/gameserver/:id/message` call and a diagnostic log containing the resolved private message.

Add negative executions for:

- option disabled;
- phase `normal:6`;
- more than one online player.

Require no private-message diagnostic in all negative cases.

**Step 2: Run and verify RED**

Expected: schema fields and private notice logs are absent.

**Step 3: Add config and localized messages**

Add English preset `Blood Moon is today.` and Polish preset `Dzisiaj będzie Krwawy Księżyc.` under `privateBloodMoonTodayMessage`. Allow a non-empty user override via existing `resolveMessage` behavior.

**Step 4: Implement the join data flow**

In `monitorJoin`:

1. Keep existing Discord join monitoring.
2. Return from private-notice logic unless the new option is true and `player` exists.
3. Read `BLOOD_STATE_KEY` through the real variable API.
4. Continue only for phase strings beginning `today:` or `start:`.
5. Call `getOnlinePlayers(gameServerId)` and continue only when `onlinePlayers === 1`.
6. Send `resolveMessage(config, 'privateBloodMoonTodayMessage')` with `player.pm`.
7. Log a stable success marker after the API call for integration evidence.

The Discord send and private game send must be independent. A missing monitoring channel remains a skip, while a configured-but-forbidden Discord channel remains a visible failure.

**Step 5: Run and verify GREEN**

Expected: positive English, Polish/override, and all suppression cases pass through real Takaro executions.

**Step 6: Commit**

```bash
git add modules/discord-7d2d-status-bridge/module.json modules/discord-7d2d-status-bridge/src/functions/discord-7d2d-status-helpers.js modules/discord-7d2d-status-bridge/src/hooks/monitor-join/index.js modules/discord-7d2d-status-bridge/test/bridge.test.ts
git commit -m "feat: notify first player of blood moon day"
```

### Task 5: Verify export, Takaro, Discord, and game boundaries

**Files:**
- Verify: `modules/discord-7d2d-status-bridge/**`

**Step 1: Run static verification**

```bash
npm run build
npm run typecheck
node --check modules/discord-7d2d-status-bridge/src/functions/discord-7d2d-status-helpers.js
node --check modules/discord-7d2d-status-bridge/src/hooks/monitor-join/index.js
node dist/scripts/module-to-json.js modules/discord-7d2d-status-bridge /tmp/discord-7d2d-status-bridge-feedback.json
git diff --check origin/main...HEAD
```

Expected: all commands succeed; the export retains the canonical name and a non-empty description.

**Step 2: Run the complete focused integration suite**

Run the Task 1 focused command with the designated QA Discord channel.

Expected: all focused tests pass, a real Discord POST returns 200, and no outbound assertion is satisfied by `skipped message`.

**Step 3: Run mandatory Paper/bot verification**

Start `paper`, `bot`, and `redis`; use the actual `BOT_PORT` from `.env` without printing secrets. Install a disposable supported-games-neutral export, connect one bot, seed a real phase variable, trigger the join hook, and verify the private message through both the Takaro execution event and bot-visible game output.

Expected: the bot receives the private Blood Moon message and the hook event is successful. State clearly that Paper does not prove 7D2D `gettime` parsing.

**Step 4: Run 7D2D live proof when the active lane is reachable**

Install the disposable module on the designated QA 7D2D server, trigger/observe a phase boundary, and verify the one-minute cron plus Discord delivery. Do not claim precise 7D2D acceptance without this evidence.

**Step 5: Review and commit any verification-only documentation**

Keep runtime artifacts and temporary exports outside the repository. Confirm `git status --short` contains only intended source/test/design files.
