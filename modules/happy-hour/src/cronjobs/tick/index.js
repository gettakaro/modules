import { data, takaro } from '@takaro/helpers';
import {
  MINUTE_MS,
  dueStep,
  getState,
  setState,
  isRunning,
  startEvent,
  endEvent,
  getTextContext,
  fill,
  eventValues,
  broadcast,
  announceDiscord,
  pmGameId,
  bonusAmount,
  vipPercent,
  economyEnabled,
  compileSchedules,
  makeZoneReader,
  cronMatches,
  minutesToCheck,
  formatMultiplier,
} from './hh-helpers.js';

async function payPlaytimeBonus(gameServerId, config, state, ctx) {
  if (!(Number(config.playtimeBaseReward) > 0)) return;
  if (!(await economyEnabled(gameServerId))) {
    console.log('tick: economy is disabled on this server; skipping playtime bonus.');
    return;
  }

  let page = 0;
  let paid = 0;
  while (true) {
    const res = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], online: [true] },
      limit: 100,
      page,
    });
    const pogs = res.data.data;
    // Sequential on purpose: the module sandbox caps concurrent outbound requests.
    for (const pog of pogs) {
      const amount = bonusAmount(config.playtimeBaseReward, state.multiplier, vipPercent(pog));
      if (amount <= 0) continue;
      try {
        await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, pog.playerId, {
          currency: amount,
        });
        paid++;
        if (config.notifyPlaytimeBonus) {
          await pmGameId(
            gameServerId,
            pog.gameId,
            fill(config.playtimeBonusMessage, { amount, currency: ctx.currency, multiplier: formatMultiplier(state.multiplier) }),
          );
        }
      } catch (err) {
        console.error(`tick: playtime bonus for player ${pog.playerId} failed: ${err}`);
      }
    }
    if (pogs.length < 100) break;
    page++;
  }
  console.log(`tick: paid playtime bonus to ${paid} online player(s)`);
}

async function main() {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;
  const now = Date.now();

  let state = await getState(gameServerId, moduleId);
  const minutes = minutesToCheck(state.lastTickAt, now);
  const compiled = compileSchedules(config);
  const readZone = makeZoneReader(config.timezone);

  // 1. Finish an event whose time is up.
  if (state.active && !isRunning(state, now)) {
    console.log(`tick: event over (ended ${state.endsAt})`);
    await endEvent({ gameServerId, moduleId, config, state, reason: 'expired' });
    state = await getState(gameServerId, moduleId);
  }

  // 2. Start a scheduled event whose cron matched since the last tick.
  if (!isRunning(state, now)) {
    let started = false;
    for (const m of minutes) {
      if (started) break;
      const t = readZone(m);
      for (const entry of compiled) {
        if (!cronMatches(entry.cron, t)) continue;
        const duration = Number(entry.schedule.durationMinutes) || 60;
        if (m + duration * MINUTE_MS <= now) continue;
        const multiplier = Number(entry.schedule.multiplier) > 1 ? Number(entry.schedule.multiplier) : config.multiplier;
        console.log(`tick: schedule #${entry.index + 1} '${entry.schedule.cron}' matched, starting ${duration} min at ${formatMultiplier(multiplier)}`);
        state = await startEvent({
          gameServerId,
          moduleId,
          config,
          durationMinutes: duration,
          multiplier,
          source: 'schedule',
          startAt: m,
          now,
        });
        started = true;
        break;
      }
    }
  }

  const ctx = await getTextContext(gameServerId);

  if (isRunning(state, now)) {
    // 3. Reminders while the event runs.
    const reminderEvery = Number(config.reminderIntervalMinutes) || 0;
    const remaining = new Date(state.endsAt).getTime() - now;
    const reminderAt = reminderEvery > 0 ? dueStep(state.lastReminderAt || state.startedAt, now, reminderEvery * MINUTE_MS) : null;
    if (reminderAt && remaining > MINUTE_MS) {
      await broadcast(gameServerId, fill(config.reminderMessage, eventValues(state, now, ctx)));
      state.lastReminderAt = reminderAt;
    }

    // 4. Playtime bonus for everyone online.
    const payEvery = Math.max(1, Number(config.playtimeIntervalMinutes) || 10);
    const payAt = dueStep(state.lastPlaytimeAt || state.startedAt, now, payEvery * MINUTE_MS);
    if (payAt) {
      await payPlaytimeBonus(gameServerId, config, state, ctx);
      state.lastPlaytimeAt = payAt;
    }
  } else {
    // 5. Heads-up before a scheduled start.
    const lead = Number(config.preAnnounceMinutes) || 0;
    if (lead > 0) {
      const announced = new Set();
      for (const m of minutes) {
        const t = readZone(m + lead * MINUTE_MS);
        for (const entry of compiled) {
          if (announced.has(entry.index) || !cronMatches(entry.cron, t)) continue;
          announced.add(entry.index);
          const multiplier = Number(entry.schedule.multiplier) > 1 ? Number(entry.schedule.multiplier) : config.multiplier;
          const message = fill(config.preAnnounceMessage, {
            minutes: lead,
            multiplier: formatMultiplier(multiplier),
            currency: ctx.currency,
            prefix: ctx.prefix,
          });
          await broadcast(gameServerId, message);
          await announceDiscord(config, message);
        }
      }
    }
  }

  // Re-read so a command that changed the event during this tick is not overwritten.
  const latest = await getState(gameServerId, moduleId);
  const merged =
    latest.startedAt === state.startedAt && latest.active === state.active
      ? { ...latest, lastReminderAt: state.lastReminderAt, lastPlaytimeAt: state.lastPlaytimeAt }
      : latest;
  await setState(gameServerId, moduleId, { ...merged, lastTickAt: new Date(now).toISOString() });
}

await main();
