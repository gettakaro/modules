# Discord 7D2D Monitoring Feedback Design

## Goal

Make `discord-7d2d-status-bridge` behave honestly and usefully in the user's real setup: monitoring delivery must either reach the configured Discord text channel or explain exactly why Discord rejected it, Blood Moon phase notices should be detected promptly, and an optional private Blood Moon notice should be sent when the first player joins.

## Confirmed failure

The user's `updateStatus` execution successfully reads players, server details, and `gettime`, then receives HTTP 403 from `POST /discord/channels/:id/message`. `bloodMoonMonitor` reports success during ordinary phases because it updates state without sending a Discord message. Existing integration tests use an empty monitoring channel and therefore exercise the skip path rather than outbound Discord delivery.

The module cannot grant Discord permissions or make Takaro's bot join an inaccessible private or archived thread. It can preserve the channel-ID/Takaro-bot flow, expose a direct delivery check, and turn generic 403 failures into actionable diagnostics. Real acceptance still requires a regular Discord text channel that the Takaro bot can view and send to.

## Design

### Discord monitoring delivery

- Keep `monitoringChannelId`; do not introduce webhooks.
- Centralize Discord API error classification in the shared helper.
- For HTTP 403, log and throw an actionable error that names the channel and asks the operator to use a normal text channel and grant the Takaro bot `View Channel`, `Send Messages`, and `Read Message History`. Explicitly call out private or archived threads.
- Preserve other API errors and include their status/code without leaking credentials.
- Do not silently fall back to the chat channel, because that would break the requested channel separation.

### Blood Moon timing

- Change `bloodMoonMonitor` from every five minutes to every minute. The cron remains transition-based, so it sends at most once per phase and does not spam.
- Keep status-message refresh at five minutes to avoid unnecessary player/time/API traffic.
- Document that interval `1` means every in-game day; detection happens on the first one-minute cron tick after the configured in-game boundary.

### Private first-player notice

- Add `privateBloodMoonNoticeOnFirstJoin`, defaulting to `false` so existing installations do not gain unsolicited private messages.
- Add an optional `privateBloodMoonTodayMessage` override with English and Polish presets.
- The one-minute Blood Moon monitor remains the source of truth by persisting its current phase. On `player-connected`, read that phase and query only the online-player list. If the option is enabled, the phase is `today` or `start`, and the joining player is the only online player, send the resolved message with `player.pm`.
- Discord join monitoring and the private in-game notice remain independent: a Discord delivery failure must still fail visibly, while the private notice uses the game messaging path.

## Testing

- Extend the real Takaro integration suite first and observe failures before implementation.
- Replace empty-channel false positives for monitoring behavior with assertions that distinguish `skipped` from attempted delivery.
- Use a configured QA Discord channel for a real send when `TAKARO_DISCORD_TEST_CHANNEL_ID` is present; never fake the Takaro helper or replace source strings.
- Cover the actionable 403 diagnostic through a real execution log where the environment provides an inaccessible channel.
- Cover first-player private notice, non-Blood-Moon suppression, and second-player suppression through real Takaro hooks and event/game logs.
- Run TypeScript build, focused integration tests, export conversion, and mandatory Paper/bot verification. A live 7D2D run is required for precise `gettime`/Blood Moon claims; Paper proves only the game-agnostic join/private-message and Discord delivery paths.

## Delivery boundary

The module fix is complete only when source and real-Takaro tests pass and a real Discord POST succeeds in the QA channel. The affected user's channel can still require a one-time Discord configuration correction if Takaro receives 403 for that specific channel; the new command and error text will identify that directly.
