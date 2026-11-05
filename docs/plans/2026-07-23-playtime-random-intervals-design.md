# Playtime Item Rewards: Persistent Random Intervals

## Goal

Let server administrators configure either a fixed playtime reward interval or a
random interval range. Random intervals are selected independently for each
player and reward cycle, remain stable across cron runs and offline sessions,
and are replaced only after the current cycle is consumed.

## User configuration

The existing `playtimeIntervalMinutes` field remains the minimum interval and
continues to act as the fixed interval when no maximum is configured. Add an
optional `playtimeIntervalMaximumMinutes` integer beside it. Its dashboard
description must state that leaving it empty, or setting it equal to the
minimum, produces a fixed interval.

Role overrides receive the same optional maximum field. A role override that
sets neither interval field inherits the complete default range. If it sets a
minimum but no maximum, it is a fixed interval. If it sets only a maximum, it
uses the default minimum with that maximum. At runtime, a maximum below the
minimum is clamped to the minimum so an invalid range cannot destabilize the
cronjob.

The existing `messageDelivery` user setting remains editable and unchanged.

## Scheduling and persistence

The module stores a per-player schedule for each effective reward profile. A
profile key includes the profile name, minimum interval, and maximum interval,
so switching roles or changing range configuration does not reuse an
incompatible schedule.

Each schedule records:

- the randomly selected interval in minutes;
- the accumulated-playtime threshold in seconds at which the reward becomes
  eligible.

When no schedule exists, the module chooses an inclusive random integer between
the configured minimum and maximum and stores the resulting threshold. Repeated
cron runs reuse this stored threshold. Going offline does not modify it.

After a successful grant or a completed no-drop outcome, the next interval is
chosen and the next threshold is based on the player's current accumulated
playtime. Failed item delivery does not advance the schedule, so the eligible
cycle can retry.

For legacy fixed-interval state, the first schedule is derived from the last
consumed bucket. This prevents an upgrade from immediately duplicating a reward
that was already consumed.

## Messages and state safety

`{intervalMinutes}` renders the interval selected for the completed cycle, not
the minimum bound. Private, broadcast, both, and off delivery modes continue to
work as before.

The existing claim lifecycle remains in place. A claim records the profile key,
selected interval, and eligible threshold. Completion verifies the same claim
before advancing the persisted schedule. Ambiguous post-delivery failures keep
the claim locked to avoid duplicate item grants.

## Verification

Automated tests must use the real Takaro API. They will verify that:

- the new default and role-override fields survive module import and install;
- a range creates a selected interval within its inclusive bounds;
- a second cron execution before eligibility reuses the same stored interval;
- a maximum below the minimum is normalized to a fixed minimum interval;
- the existing fixed interval, message delivery, and below-threshold behavior
  remain compatible.

Mandatory Paper verification will use a short range, disconnect and reconnect a
bot, trigger the cronjob, and inspect the Takaro execution event, bot inventory,
private message, and persisted next schedule. The final source export will then
replace the community catalog JSON so administrators can edit the new maximum
field in the dashboard.
