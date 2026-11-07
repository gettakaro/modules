import { takaro } from '@takaro/helpers';

function plural(count, unit) {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

export function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes <= 0) {
    return 'less than a minute';
  }
  const units = [
    [Math.floor(totalMinutes / 1440), 'day'],
    [Math.floor((totalMinutes % 1440) / 60), 'hour'],
    [totalMinutes % 60, 'minute'],
  ];
  const first = units.findIndex(([count]) => count > 0);
  const parts = [units[first]];
  const next = units[first + 1];
  if (next && next[0] > 0) {
    parts.push(next);
  }
  return parts.map(([count, unit]) => plural(count, unit)).join(' ');
}

export function formatWipeTime(iso, timezone) {
  const options = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  try {
    return new Date(iso).toLocaleString('en-GB', { ...options, timeZone: timezone });
  } catch {
    return new Date(iso).toLocaleString('en-GB', { ...options, timeZone: 'UTC' });
  }
}

export function renderTemplate(template, values) {
  let text = template;
  for (const [key, value] of Object.entries(values)) {
    text = text.replaceAll(`{${key}}`, () => value ?? '');
  }
  return text.replace(/\s+/g, ' ').trim();
}

export async function getSummary(gameServerId) {
  return (await takaro.wipe.wipeControllerSummary(gameServerId)).data.data;
}
