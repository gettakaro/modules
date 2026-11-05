import { data, takaro } from '@takaro/helpers';
import {
  LAST_RESULTS_KEY,
  PLACES,
  CATEGORY_LABELS,
  enabledCategories,
  loadState,
  startNewPeriod,
  computeStandings,
  attachNames,
  rewardWinner,
  writeJson,
  getSetting,
  formatValue,
  currencyForPlace,
  liveListSize,
  buildLeaderboardEmbed,
  upsertLiveMessage,
} from './wtr-helpers.js';

async function broadcast(gameServerId, message) {
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message });
}

async function main() {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;
  const now = new Date();
  const nowIso = now.toISOString();

  const prefix = await getSetting('commandPrefix', gameServerId, '/');
  const currencyName = await getSetting('currencyName', gameServerId, 'coins');
  const categories = enabledCategories(config);

  const state = await loadState(gameServerId, moduleId);
  if (!state) {
    // First run: there is no baseline yet, so start the first period now and pay nothing.
    await startNewPeriod(gameServerId, moduleId, nowIso);
    console.log('weekly-top-rewards: no period found, started the first one');
    if (config.broadcastResults) {
      await broadcast(gameServerId, `Weekly Top has started! Type ${prefix}weeklytop to see this week's standings.`);
    }
    return;
  }

  const standings = await computeStandings({ gameServerId, moduleId, config, state, categories, endIso: nowIso });

  // Close the period before paying, so a re-run can never pay the same week twice.
  await startNewPeriod(gameServerId, moduleId, nowIso);

  const results = { periodStart: state.periodStart, periodEnd: nowIso, categories: {} };
  const lines = [];
  for (const category of categories) {
    const ranked = standings[category];
    if (ranked === null) {
      lines.push(`${CATEGORY_LABELS[category]}: not available this week.`);
      continue;
    }
    const winners = await attachNames(ranked.slice(0, PLACES));
    results.categories[category] = [];
    for (let i = 0; i < winners.length; i++) {
      const place = i + 1;
      const winner = winners[i];
      const paid = await rewardWinner({ gameServerId, moduleId, config, playerId: winner.playerId, place, nowMs: now.getTime() });
      results.categories[category].push({ place, playerId: winner.playerId, name: winner.name, value: winner.value, reward: paid });
      console.log(`weekly-top-rewards: ${category} #${place} ${winner.name} (${winner.value}) -> ${JSON.stringify(paid)}`);
    }
    if (winners.length === 0) {
      lines.push(`${CATEGORY_LABELS[category]}: no qualifying players.`);
    } else {
      const podium = winners.map((w, i) => `${i + 1}. ${w.name} (${formatValue(category, w.value, currencyName)})`).join('  ');
      lines.push(`${CATEGORY_LABELS[category]}: ${podium}`);
    }
  }

  await writeJson(LAST_RESULTS_KEY, gameServerId, moduleId, null, results);

  if (config.discordLiveChannelId) {
    // Turn this week's live message into the final results; the next live run posts a fresh one.
    try {
      const size = liveListSize(config);
      const shown = [];
      for (const category of categories) if (standings[category]) shown.push(...standings[category].slice(0, size));
      await attachNames(shown);
      const embed = buildLeaderboardEmbed({
        standings,
        categories,
        periodStart: state.periodStart,
        periodEnd: nowIso,
        currencyName,
        size,
        final: true,
        nowIso,
      });
      await upsertLiveMessage({
        gameServerId,
        moduleId,
        channelId: config.discordLiveChannelId,
        periodStart: state.periodStart,
        embed,
      });
    } catch (err) {
      console.error(`weekly-top-rewards: could not finalise the live Discord leaderboard: ${err}`);
    }
  }

  const prizes = [1, 2, 3].map((p) => currencyForPlace(config, p));
  const prizeLine = prizes.some((p) => p > 0) ? `Prizes: ${prizes.join(' / ')} ${currencyName} for places 1-3.` : null;

  if (config.broadcastResults) {
    await broadcast(gameServerId, 'Weekly Top results are in!');
    for (const line of lines) await broadcast(gameServerId, line);
    if (prizeLine) await broadcast(gameServerId, prizeLine);
    await broadcast(gameServerId, `A new week has started. Type ${prefix}weeklytop to see the standings.`);
  }

  if (config.discordChannelId) {
    const message = ['**Weekly Top results**', ...lines, prizeLine].filter(Boolean).join('\n');
    try {
      await takaro.discord.discordControllerSendMessage(config.discordChannelId, { message });
    } catch (err) {
      console.error(`weekly-top-rewards: Discord post failed: ${err}`);
    }
  }
}

await main();
