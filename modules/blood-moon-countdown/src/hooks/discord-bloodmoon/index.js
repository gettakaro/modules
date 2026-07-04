import { data, takaro } from '@takaro/helpers';
import { buildBloodMoonResponse } from './blood-moon-helpers.js';

function getDiscordChannelId(mod) {
  return mod?.systemConfig?.hooks?.discordBloodmoon?.discordChannelId ||
    mod?.systemConfig?.hooks?.DiscordBloodmoon?.discordChannelId ||
    mod?.systemConfig?.hooks?.DiscordToGame?.discordChannelId ||
    data.discordChannelId;
}

function getTriggers(config) {
  const configured = Array.isArray(config.discordTriggers) ? config.discordTriggers : ['!bloodmoon', '!day7'];
  return configured
    .map((trigger) => String(trigger ?? '').trim().toLowerCase())
    .filter((trigger) => trigger !== '');
}

async function main() {
  const { gameServerId, module: mod, eventData } = data;
  const config = mod.userConfig ?? {};

  if (eventData?.author?.isBot) return;

  const msg = String(eventData?.msg ?? '').trim().toLowerCase();
  const triggers = getTriggers(config);
  if (!triggers.includes(msg)) return;

  const discordChannelId = getDiscordChannelId(mod);
  if (!discordChannelId) {
    console.warn('blood-moon-countdown: discord trigger matched but no Discord channel is configured for discordBloodmoon hook');
    return;
  }

  const result = await buildBloodMoonResponse(gameServerId, config, takaro);
  const message = result?.message ||
    config.parseErrorMessage ||
    "I couldn't read the current game day. Ask an admin to check the blood-moon-countdown module config or set manualCurrentDay.";

  await takaro.discord.discordControllerSendMessage(discordChannelId, { message });

  if (result) {
    console.log(
      `blood-moon-countdown: discord reply currentDay=${result.currentDay}, nextHordeDay=${result.nextHordeDay}, daysUntil=${result.daysUntil}, source=${result.source}`,
    );
  }
}

await main();
