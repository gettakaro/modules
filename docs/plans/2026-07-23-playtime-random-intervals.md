# Persistent Random Playtime Intervals Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add clear user-configurable minimum/maximum playtime intervals whose randomly selected per-player cycle survives cron reruns and offline sessions.

**Architecture:** Preserve the existing fixed `playtimeIntervalMinutes` behavior when no maximum is configured. Store a per-profile schedule containing the chosen interval and accumulated-playtime threshold; advance that schedule only after a completed grant or no-drop cycle, while retaining the existing claim safety model.

**Tech Stack:** Takaro module JSON schema, server-side JavaScript with `@takaro/helpers`, TypeScript integration tests using the real Takaro API, Minecraft Paper bot verification, community module JSON export.

---

### Task 1: Expose a clear editable maximum interval

**Files:**
- Modify: `modules/playtime-item-rewards/test/playtime-item-rewards.test.ts:23-104`
- Modify: `modules/playtime-item-rewards/module.json:12-17`
- Modify: `modules/playtime-item-rewards/module.json:97-100`

**Step 1: Write the failing schema test**

Extend the real import/install test to require the default and role-override
`playtimeIntervalMaximumMinutes` schemas and explicit descriptions:

```ts
type ConfigProperty = {
  type?: string;
  minimum?: number;
  default?: number | string;
  description?: string;
  items?: { properties?: Record<string, ConfigProperty> };
};

const properties = manifest.config?.properties ?? {};
assert.equal(properties.playtimeIntervalMaximumMinutes?.type, 'integer');
assert.equal(properties.playtimeIntervalMaximumMinutes?.minimum, 1);
assert.match(properties.playtimeIntervalMaximumMinutes?.description ?? '', /leave.*empty.*fixed/i);
assert.equal(
  properties.roleOverrides?.items?.properties?.playtimeIntervalMaximumMinutes?.type,
  'integer',
);
```

**Step 2: Run the focused test and verify RED**

Run:

```bash
node --test-force-exit --test-concurrency 1 --import=ts-node-maintained/register/esm \
  --test-name-pattern='pushes and installs' \
  modules/playtime-item-rewards/test/playtime-item-rewards.test.ts
```

Expected: FAIL because `playtimeIntervalMaximumMinutes` is absent.

**Step 3: Add the minimum/maximum schemas**

Keep `playtimeIntervalMinutes` as the minimum/fixed interval and make its
description explicit. Add this adjacent field to the default config and role
override config:

```json
"playtimeIntervalMaximumMinutes": {
  "type": "integer",
  "minimum": 1,
  "description": "Optional maximum interval. Leave empty or set equal to playtimeIntervalMinutes for a fixed interval."
}
```

**Step 4: Run the focused test and verify GREEN**

Run the Step 2 command again. Expected: the selected test passes.

**Step 5: Commit**

```bash
git add modules/playtime-item-rewards/module.json \
  modules/playtime-item-rewards/test/playtime-item-rewards.test.ts
git commit -m "feat(playtime-item-rewards): expose interval range config"
```

### Task 2: Persist one selected interval per player cycle

**Files:**
- Modify: `modules/playtime-item-rewards/test/playtime-item-rewards.test.ts:42-180`
- Modify: `modules/playtime-item-rewards/src/functions/playtime-item-reward-helpers.js:13-270`
- Modify: `modules/playtime-item-rewards/src/functions/playtime-item-reward-helpers.js:339-453`

**Step 1: Write the failing real-API persistence test**

Extend `RewardState` with schedules and replace the old no-state assertion with
a range test using an unreachable range on the real mock game server:

```ts
type RewardSchedule = {
  intervalMinutes: number;
  eligibleAtPlaytimeSeconds: number;
};

type RewardState = {
  schedules?: Record<string, RewardSchedule>;
  claim?: unknown;
  lastOutcome?: string;
};

it('selects and persists one interval for the current player cycle', async () => {
  // Install with min 120 and max 300, trigger twice, and read the real Takaro
  // variable after each run.
  // Assert one schedule exists, interval is 120..300 inclusive, threshold is
  // interval * 60, and both persisted schedule snapshots are deeply equal.
});
```

Add a second real-API test with minimum `300` and maximum `120`; assert the
stored interval and threshold normalize to `300` and `18000`.

**Step 2: Run the new tests and verify RED**

Run:

```bash
node --test-force-exit --test-concurrency 1 --import=ts-node-maintained/register/esm \
  --test-name-pattern='selects and persists|normalizes' \
  modules/playtime-item-rewards/test/playtime-item-rewards.test.ts
```

Expected: FAIL because no schedule is persisted before eligibility.

**Step 3: Implement range normalization and schedule persistence**

Add profile fields `intervalMinimumMinutes` and `intervalMaximumMinutes`, where
the maximum defaults to the minimum and is clamped upward. Include both bounds
in `profileStateKey`.

Add helpers with this behavior:

```js
function randomIntegerInclusive(minimum, maximum) {
  if (maximum <= minimum) return minimum;
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function createSchedule(profile, cycleStartPlaytimeSeconds) {
  const intervalMinutes = randomIntegerInclusive(
    profile.intervalMinimumMinutes,
    profile.intervalMaximumMinutes,
  );
  return {
    intervalMinutes,
    eligibleAtPlaytimeSeconds: cycleStartPlaytimeSeconds + intervalMinutes * 60,
  };
}
```

Validate `state.schedules` in `parseState`. On each player scan, create and
persist a missing schedule before checking eligibility. Re-read the variable
after writing and use the stored schedule, ensuring overlapping cron runs do not
silently reroll the cycle.

For legacy state, derive the first fixed schedule start from
`consumedBucketFor(state, legacyProfileKey) * intervalMinutes * 60`.

**Step 4: Generalize claims and cycle completion**

Replace bucket-only claim fields with `profileKey`, `intervalMinutes`, and
`eligibleAtPlaytimeSeconds`. Completion must preserve legacy consumed-bucket
fields, clear the claim, and store the next schedule based on the current
accumulated playtime. No-drop completion advances the schedule; grant failure
releases the claim without advancing it.

Pass `claim.intervalMinutes` into the reward message renderer so
`{intervalMinutes}` displays the selected cycle interval.

**Step 5: Run the focused tests and verify GREEN**

Run the Step 2 command. Expected: both selected tests pass using real Takaro
variables and cron executions.

**Step 6: Run the complete module test**

```bash
npm run build
npm run typecheck
node --check modules/playtime-item-rewards/src/functions/playtime-item-reward-helpers.js
node --test-force-exit --test-concurrency 1 --import=ts-node-maintained/register/esm \
  modules/playtime-item-rewards/test/playtime-item-rewards.test.ts
```

Expected: all non-Paper tests pass; the documented Paper-only case remains
skipped.

**Step 7: Commit**

```bash
git add modules/playtime-item-rewards/src/functions/playtime-item-reward-helpers.js \
  modules/playtime-item-rewards/test/playtime-item-rewards.test.ts
git commit -m "feat(playtime-item-rewards): persist random reward intervals"
```

### Task 3: Verify the player experience on Paper

**Files:**
- Modify: `docs/verification/2026-07-23-playtime-item-rewards-random-intervals.md`

**Step 1: Export and import a uniquely named live-test copy**

Build the exact branch source, copy it into a temporary detached worktree, and
change only the temporary manifest name to avoid replacing a shared module.
Configure minimum `1`, maximum `2`, `messageDelivery: private`, and a 100%
one-stone item.

**Step 2: Exercise reconnect behavior**

Connect `Bot_priv23`, confirm its accumulated playtime still exceeds one minute,
trigger the cronjob, and capture the `cronjob-executed` event. Verify:

- `success: true`;
- one item grant succeeds;
- the bot receives the private message;
- the completed message renders the selected `intervalMinutes`;
- persisted state contains a next schedule with interval `1` or `2`;
- disconnect/reconnect does not replace that next schedule.

**Step 3: Verify duplicate prevention**

Trigger the cronjob again before the next threshold. Verify no second item or
message is delivered and the stored schedule remains unchanged.

**Step 4: Clean up and document evidence**

Remove the temporary installation, module, bot, and detached worktree. Record
IDs, config, event results, schedule state, and cleanup confirmation in the
verification document without storing credentials.

**Step 5: Commit**

```bash
git add docs/verification/2026-07-23-playtime-item-rewards-random-intervals.md
git commit -m "test(playtime-item-rewards): verify random intervals live"
```

### Task 4: Publish the updated user-configurable module

**Files:**
- Regenerate: `/home/hendrik/community-modules-viewer/public/modules/economy/playtime-item-rewards.json`

**Step 1: Export the exact source branch**

```bash
npm run build
node dist/scripts/module-to-json.js modules/playtime-item-rewards \
  /tmp/playtime-item-rewards.json
```

Verify the export name, description, maximum interval schemas, message delivery
schema, helper code, and cronjob.

**Step 2: Push the source branch**

```bash
git push origin feat/playtime-item-rewards
```

Confirm PR #60 points at the new head and build/typecheck completes.

**Step 3: Update the viewer in an isolated branch**

Create a viewer worktree from current `origin/main`, replace only
`public/modules/economy/playtime-item-rewards.json` with the source export, and
verify filename/name equality plus a non-empty description.

**Step 4: Verify the viewer**

Run the targeted module-loader test, formatting check, typecheck, and production
build using the viewer repository's discovered scripts. Expected: all scoped
checks pass, with any unrelated baseline failures reported separately.

**Step 5: Commit, push, and create the catalog PR**

Use the `create-pr` skill. The PR description must explain the new editable
maximum field, persistent per-player cycle selection, offline behavior, private
message support, source PR relationship, and live Paper evidence.
