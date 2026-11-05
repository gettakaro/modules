import { data } from '@takaro/helpers';
import { listBounties, getSettings, potOf, isExpired } from './bounty-helpers.js';

const MAX_LINES = 10;

async function main() {
  const { pog, gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const { currency, prefix } = await getSettings(gameServerId);
  const now = new Date();

  const active = (await listBounties(gameServerId, mod.moduleId))
    .map((b) => {
      const entries = b.entries.filter((e) => !isExpired(e, config.expiryDays, now));
      return { name: b.targetName, pot: potOf(entries), placers: entries.length };
    })
    .filter((b) => b.pot > 0)
    .sort((a, b) => b.pot - a.pot);

  if (active.length === 0) {
    await pog.pm(`There are no active bounties. Place one with ${prefix}bounty <player> <amount>.`);
    return;
  }

  const lines = active
    .slice(0, MAX_LINES)
    .map((b, i) => `${i + 1}. ${b.name}: ${b.pot} ${currency}${b.placers > 1 ? ` (${b.placers} players)` : ''}`);
  const more = active.length > MAX_LINES ? `\n...and ${active.length - MAX_LINES} more.` : '';
  await pog.pm(`Active bounties:\n${lines.join('\n')}${more}`);
}

await main();
