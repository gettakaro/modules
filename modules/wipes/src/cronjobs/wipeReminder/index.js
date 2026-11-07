import { data, takaro } from '@takaro/helpers';
import { formatDuration, formatWipeTime, getSummary, renderTemplate } from './wipeUtils.js';

const STATE_KEY = 'wipeReminders';

function parseState(row) {
  if (!row) {
    return null;
  }
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function loadState(nextWipe) {
  const row = (
    await takaro.variable.variableControllerSearch({
      filters: { key: [STATE_KEY], moduleId: [data.module.moduleId], gameServerId: [data.gameServerId] },
    })
  ).data.data[0];

  const stored = parseState(row);
  const isCurrent = stored && stored.at === nextWipe.at && Array.isArray(stored.sent);
  return { row, state: isCurrent ? stored : { at: nextWipe.at, sent: [] } };
}

async function saveState(row, state) {
  const value = JSON.stringify(state);
  if (row) {
    await takaro.variable.variableControllerUpdate(row.id, { value });
  } else {
    await takaro.variable.variableControllerCreate({
      key: STATE_KEY,
      value,
      moduleId: data.module.moduleId,
      gameServerId: data.gameServerId,
    });
  }
}

async function main() {
  const { nextWipe } = await getSummary(data.gameServerId);
  if (!nextWipe) {
    return;
  }
  const remainingMs = Date.parse(nextWipe.at) - Date.now();
  if (remainingMs <= 0) {
    return;
  }

  const { row, state } = await loadState(nextWipe);
  const due = data.module.userConfig.reminders.filter(
    (reminder) => reminder.minutesBefore * 60000 >= remainingMs && !state.sent.includes(reminder.minutesBefore),
  );
  if (due.length === 0) {
    return;
  }

  // One message for all crossed offsets (late install): the closest one has the right wording.
  const closest = due.reduce((best, reminder) => (reminder.minutesBefore < best.minutesBefore ? reminder : best));
  const message = renderTemplate(closest.message, {
    timeLeft: formatDuration(remainingMs),
    time: formatWipeTime(nextWipe.at, nextWipe.timezone),
    wipeType: nextWipe.wipeTypeName,
  });
  if (message) {
    await takaro.gameserver.gameServerControllerSendMessage(data.gameServerId, { message });
  }

  state.sent = [...new Set([...state.sent, ...due.map((reminder) => reminder.minutesBefore)])];
  await saveState(row, state);
}

await main();
