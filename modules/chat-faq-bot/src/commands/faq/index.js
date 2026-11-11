import { data, TakaroUserError } from '@takaro/helpers';
import { activeEntries, findEntryByTopic, renderAnswer, splitLines, getSetting, restOfLine } from './faq-utils.js';

async function main() {
  const { gameServerId, player, pog, arguments: args, chatMessage, module: mod } = data;
  const config = mod.userConfig;
  const entries = activeEntries(config);
  const prefix = await getSetting(gameServerId, 'commandPrefix', '/');

  if (entries.length === 0) {
    throw new TakaroUserError('There are no FAQ topics on this server yet.');
  }

  const topic = restOfLine(chatMessage, prefix, args.topic);
  // Takaro fills in "list" when the player typed no topic.
  if (!topic || ['list', 'all', 'topics'].includes(topic.toLowerCase())) {
    await pog.pm(`FAQ topics: ${entries.map((e) => e.topic).join(', ')}`);
    await pog.pm(`Type ${prefix}faq <topic> to read one, or just ask in chat.`);
    return;
  }

  const entry = findEntryByTopic(config, topic);
  if (!entry) {
    throw new TakaroUserError(
      `No FAQ topic "${topic}". Topics: ${entries.map((e) => e.topic).join(', ')}`,
    );
  }

  const answer = await renderAnswer(entry.answer, { gameServerId, playerName: player.name, config });
  for (const line of splitLines(answer)) {
    await pog.pm(`${config.messagePrefix || ''}${line}`);
  }
}

await main();
