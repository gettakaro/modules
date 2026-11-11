import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { findMatchingEntry, renderAnswer, splitLines, getSetting, restOfLine } from './faq-utils.js';

async function main() {
  const { gameServerId, player, pog, arguments: args, chatMessage, module: mod } = data;
  if (!checkPermission(pog, 'FAQ_BOT_MANAGE')) {
    throw new TakaroUserError('You do not have permission to manage the FAQ bot.');
  }

  const prefix = await getSetting(gameServerId, 'commandPrefix', '/');
  const message = restOfLine(chatMessage, prefix, args.message);
  if (!message) throw new TakaroUserError(`Give a sample chat message, e.g. ${prefix}faqtest how do i get money`);

  const entry = findMatchingEntry(mod.userConfig, message);
  if (!entry) {
    await pog.pm(`No FAQ entry matches "${message}".`);
    return;
  }

  const answer = await renderAnswer(entry.answer, { gameServerId, playerName: player.name, config: mod.userConfig });
  await pog.pm(`Matches "${entry.topic}" (${entry.reply || 'pm'}). Answer preview (no cooldown used):`);
  for (const line of splitLines(answer)) await pog.pm(line);
}

await main();
