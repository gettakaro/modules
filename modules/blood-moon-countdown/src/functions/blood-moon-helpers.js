export function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  return fallback;
}

export function extractCurrentDay(rawOutput) {
  const text = String(rawOutput ?? '').replace(/\r/g, '\n');

  const patterns = [
    /\bday\s*[:#-]?\s*(\d+)\b/i,
    /\bd\s*[:#-]?\s*(\d+)\b/i,
    /\bgame\s+time\b[^\d]*(\d+)\b/i,
    /\bworld\s+time\b[^\d]*(\d+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const day = Number.parseInt(match[1], 10);
      if (Number.isFinite(day) && day >= 1) return day;
    }
  }

  return null;
}

export function calculateNextHordeDay(currentDay, interval, firstHordeDay) {
  const safeCurrentDay = toPositiveInteger(currentDay, 1);
  const safeInterval = toPositiveInteger(interval, 7);
  const safeFirstHordeDay = toPositiveInteger(firstHordeDay, safeInterval);

  if (safeCurrentDay <= safeFirstHordeDay) {
    return safeFirstHordeDay;
  }

  const cyclesSinceFirst = Math.ceil((safeCurrentDay - safeFirstHordeDay) / safeInterval);
  return safeFirstHordeDay + cyclesSinceFirst * safeInterval;
}

export function renderBloodMoonMessage(template, values) {
  const replacements = {
    currentDay: values.currentDay,
    nextHordeDay: values.nextHordeDay,
    daysUntil: values.daysUntil,
    daysUntilText: values.daysUntilText,
    interval: values.interval,
    firstHordeDay: values.firstHordeDay,
    source: values.source,
  };

  let message = String(template || 'Blood moon: Day {nextHordeDay}. Current day: {currentDay}. {daysUntilText}.');
  for (const [key, value] of Object.entries(replacements)) {
    message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
  }
  return message;
}

export function buildDaysUntilText(config, daysUntil) {
  if (daysUntil === 0) {
    return String(config.hordeTodayText || 'Blood moon is tonight');
  }

  const template = String(config.daysUntilText || '{daysUntil} day(s) remaining');
  return template.replace(/\{daysUntil\}/g, String(daysUntil));
}

async function readCurrentDayFromConsole(gameServerId, config, takaro) {
  const command = String(config.timeConsoleCommand || 'gettime').trim();
  if (command === '') {
    throw new Error('Blood moon countdown is misconfigured: timeConsoleCommand is empty.');
  }

  const result = await takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, { command });
  const possibleOutputs = [
    result?.data?.data?.rawResult,
    result?.data?.data?.result,
    result?.data?.data?.output,
    result?.data?.data?.message,
    result?.data?.data,
    result?.data,
    result,
  ];

  for (const possibleOutput of possibleOutputs) {
    const day = extractCurrentDay(
      typeof possibleOutput === 'string' ? possibleOutput : JSON.stringify(possibleOutput ?? ''),
    );
    if (day !== null) {
      return { currentDay: day, source: 'console' };
    }
  }

  if (config.includeConsoleOutputInLogs ?? true) {
    console.warn(`blood-moon-countdown: failed to parse day from console command '${command}'. Result: ${JSON.stringify(result)}`);
  } else {
    console.warn(`blood-moon-countdown: failed to parse day from console command '${command}'.`);
  }

  return null;
}

export async function resolveCurrentDay(gameServerId, config, takaro) {
  if (config.parseConsoleTime ?? true) {
    try {
      const parsed = await readCurrentDayFromConsole(gameServerId, config, takaro);
      if (parsed) return parsed;
    } catch (err) {
      console.warn(`blood-moon-countdown: console time lookup failed: ${err}`);
    }

    if (!(config.allowManualFallbackOnParseFailure ?? false)) {
      return null;
    }
  }

  const fallbackDay = toPositiveInteger(config.manualCurrentDay, null);
  if (fallbackDay !== null) {
    return { currentDay: fallbackDay, source: 'manual' };
  }

  return null;
}

export async function buildBloodMoonResponse(gameServerId, config, takaro) {
  const resolved = await resolveCurrentDay(gameServerId, config, takaro);
  if (!resolved) return null;

  const interval = toPositiveInteger(config.hordeIntervalDays, 7);
  const firstHordeDay = toPositiveInteger(config.firstHordeDay, interval);
  const nextHordeDay = calculateNextHordeDay(resolved.currentDay, interval, firstHordeDay);
  const daysUntil = Math.max(0, nextHordeDay - resolved.currentDay);
  const daysUntilText = buildDaysUntilText(config, daysUntil);
  const message = renderBloodMoonMessage(config.responseTemplate, {
    currentDay: resolved.currentDay,
    nextHordeDay,
    daysUntil,
    daysUntilText,
    interval,
    firstHordeDay,
    source: resolved.source,
  });

  return {
    message,
    currentDay: resolved.currentDay,
    nextHordeDay,
    daysUntil,
    source: resolved.source,
  };
}
