import { data } from '@takaro/helpers';
import { findMatchingEntry, renderAnswer, splitLines, checkCooldowns, deliver, getSetting } from './faq-utils.js';

async function main() {
  const { gameServerId, eventData, player, pog, module: mod } = data;
  const config = mod.userConfig;

  // Server/bot messages carry no player: never answer those.
  if (!player || !pog) return;

  const message = String(eventData?.msg ?? '').trim();
  if (message.length < (config.minMessageLength ?? 0)) return;

  // Commands are not questions: skip the Takaro prefix and any configured game prefixes.
  const prefix = await getSetting(gameServerId, 'commandPrefix', '/');
  const prefixes = [prefix, ...(config.ignorePrefixes || [])].filter((p) => typeof p === 'string' && p.length > 0);
  if (prefixes.some((p) => message.startsWith(p))) return;

  const entry = findMatchingEntry(config, message);
  if (!entry) return;

  const cooldown = await checkCooldowns({
    gameServerId,
    moduleId: mod.moduleId,
    playerId: player.id,
    entry,
  });
  if (cooldown.onCooldown) {
    console.log(`chat-faq-bot: "${entry.topic}" matched but is on cooldown`);
    return;
  }

  const answer = await renderAnswer(entry.answer, { gameServerId, playerName: player.name, config });
  const lines = splitLines(answer).map((l) => `${config.messagePrefix || ''}${l}`);
  if (lines.length === 0) return;

  // Start the cooldown first, so a burst of identical questions cannot all get through.
  await cooldown.commit();
  const via = await deliver({
    gameServerId,
    pog,
    lines,
    reply: entry.reply || 'pm',
    fallbackToPublic: config.fallbackToPublic !== false,
  });
  console.log(`chat-faq-bot: answered "${entry.topic}" for ${player.name} (${via})`);
}

await main();
