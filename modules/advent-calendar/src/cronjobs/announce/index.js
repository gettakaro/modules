import { data, takaro } from '@takaro/helpers';
import { ANNOUNCED_KEY, eventName, fill, findVariable, getTextContext, resolveEvent, saveVariable } from './advent-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig;
  if (config.announceNewDoor === false) return;
  const event = resolveEvent(config, Date.now());
  if (event.status !== 'running') return;

  const marker = `${event.eventKey}#${event.today}`;
  const last = await findVariable(ANNOUNCED_KEY, gameServerId, mod.moduleId);
  if (last && last.value === marker) return;
  await saveVariable(ANNOUNCED_KEY, gameServerId, mod.moduleId, null, marker);

  const { prefix, currency } = await getTextContext(gameServerId);
  const template = event.today === event.totalDays ? config.lastDoorAnnounceMessage : config.announceMessage;
  const message = fill(template, {
    door: event.today,
    total: event.totalDays,
    event: eventName(config),
    prefix,
    currency,
  });
  if (message) await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message });
}

await main();
