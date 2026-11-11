import { data, checkPermission, TakaroUserError } from '@takaro/helpers';
import { compileRegex } from './faq-utils.js';

async function main() {
  const { pog, module: mod } = data;
  if (!checkPermission(pog, 'FAQ_BOT_MANAGE')) {
    throw new TakaroUserError('You do not have permission to manage the FAQ bot.');
  }

  const entries = mod.userConfig.entries || [];
  if (entries.length === 0) {
    await pog.pm('No FAQ entries configured. Add them in the module config.');
    return;
  }

  await pog.pm(`${entries.length} FAQ entries (first match wins):`);
  for (const [i, e] of entries.entries()) {
    const triggers = e.triggers || [];
    const bad = e.match === 'regex' ? triggers.filter((t) => !compileRegex(t)) : [];
    const flags = [
      e.enabled === false ? 'OFF' : null,
      bad.length ? `INVALID REGEX: ${bad.join(', ')}` : null,
    ].filter(Boolean);
    await pog.pm(
      `${i + 1}. ${e.topic} [${e.match || 'any'}, ${e.reply || 'pm'}, cd ${e.cooldownSeconds ?? 0}s/` +
        `${e.playerCooldownSeconds ?? 0}s]${flags.length ? ` ${flags.join(' ')}` : ''}: ${triggers.join(' | ')}`,
    );
  }
}

await main();
