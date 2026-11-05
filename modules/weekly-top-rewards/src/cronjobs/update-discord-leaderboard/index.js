import { data } from '@takaro/helpers';
import {
  enabledCategories,
  loadState,
  getSetting,
  liveListSize,
  liveStandingsWithNames,
  buildLeaderboardEmbed,
  upsertLiveMessage,
} from './wtr-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;
  const channelId = config.discordLiveChannelId;

  // Off unless a channel is set: no requests at all.
  if (!channelId) return;

  const state = await loadState(gameServerId, moduleId);
  if (!state) {
    console.log('weekly-top-rewards: no week running yet; the live leaderboard starts after the first /weeklytop or award run');
    return;
  }

  const categories = enabledCategories(config);
  const size = liveListSize(config);
  const nowIso = new Date().toISOString();
  const currencyName = await getSetting('currencyName', gameServerId, 'coins');
  const standings = await liveStandingsWithNames({ gameServerId, moduleId, config, state, categories, endIso: nowIso, size });

  const embed = buildLeaderboardEmbed({
    standings,
    categories,
    periodStart: state.periodStart,
    currencyName,
    size,
    final: false,
    nowIso,
  });
  await upsertLiveMessage({ gameServerId, moduleId, channelId, periodStart: state.periodStart, embed });
}

await main();
