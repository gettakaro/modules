import { data, takaro, TakaroUserError } from '@takaro/helpers';
import { buildBloodMoonResponse } from './blood-moon-helpers.js';

async function main() {
  const { gameServerId, pog, module: mod } = data;
  const config = mod.userConfig ?? {};

  const result = await buildBloodMoonResponse(gameServerId, config, takaro);
  if (!result) {
    throw new TakaroUserError(
      config.parseErrorMessage ||
        "I couldn't read the current game day. Ask an admin to check the blood-moon-countdown module config or set manualCurrentDay.",
    );
  }

  console.log(
    `blood-moon-countdown: currentDay=${result.currentDay}, nextHordeDay=${result.nextHordeDay}, daysUntil=${result.daysUntil}, source=${result.source}`,
  );
  await pog.pm(result.message);
}

await main();
