import { data, TakaroUserError } from '@takaro/helpers';
import {
  LAST_RESULTS_KEY,
  CATEGORY_LABELS,
  enabledCategories,
  resolveCategory,
  loadState,
  startNewPeriod,
  computeStandings,
  attachNames,
  readJson,
  getSetting,
  formatValue,
  formatDate,
} from './wtr-helpers.js';

const PODIUM = 3;

function ownRank(ranked, playerId) {
  const index = ranked.findIndex((e) => e.playerId === playerId);
  return index === -1 ? null : { place: index + 1, entry: ranked[index] };
}

async function showLast(gameServerId, moduleId, currencyName, player) {
  const last = await readJson(LAST_RESULTS_KEY, gameServerId, moduleId);
  if (!last) {
    await player.pm('No week has finished yet.');
    return;
  }
  await player.pm(`Last week's winners (${formatDate(last.periodStart)} - ${formatDate(last.periodEnd)}):`);
  for (const [category, winners] of Object.entries(last.categories)) {
    const podium = winners.length
      ? winners.map((w) => `${w.place}. ${w.name} (${formatValue(category, w.value, currencyName)})`).join('  ')
      : 'no qualifying players';
    await player.pm(`${CATEGORY_LABELS[category]}: ${podium}`);
  }
}

async function main() {
  const { gameServerId, pog: player, module: mod, arguments: args } = data;
  const config = mod.userConfig;
  const moduleId = mod.moduleId;
  const categories = enabledCategories(config);
  const currencyName = await getSetting('currencyName', gameServerId, 'coins');

  const raw = String(args.category || 'all').trim().toLowerCase();

  if (raw === 'last') {
    await showLast(gameServerId, moduleId, currencyName, player);
    return;
  }

  let requested = categories;
  if (raw !== 'all') {
    const category = resolveCategory(raw);
    if (!category || !categories.includes(category)) {
      const prefix = await getSetting('commandPrefix', gameServerId, '/');
      throw new TakaroUserError(
        `Unknown category "${raw}". Try: ${prefix}weeklytop ${[...categories, 'last'].join(` | ${prefix}weeklytop `)}`,
      );
    }
    requested = [category];
  }

  if (categories.length === 0) {
    throw new TakaroUserError('Weekly Top has no categories enabled. Ask an admin to configure the module.');
  }

  let state = await loadState(gameServerId, moduleId);
  if (!state) {
    state = await startNewPeriod(gameServerId, moduleId, new Date().toISOString());
    await player.pm('Weekly Top tracking just started. Play, and check back later!');
    return;
  }

  const standings = await computeStandings({
    gameServerId,
    moduleId,
    config,
    state,
    categories: requested,
    endIso: new Date().toISOString(),
  });

  const listSize = requested.length === 1 ? Math.max(PODIUM, Math.floor(Number(config.liveListSize) || 5)) : PODIUM;

  await player.pm(`Weekly Top since ${formatDate(state.periodStart)}:`);
  for (const category of requested) {
    const ranked = standings[category];
    const label = CATEGORY_LABELS[category];
    if (ranked === null) {
      await player.pm(`${label}: not available right now.`);
      continue;
    }
    const top = ranked.slice(0, listSize);
    const mine = ownRank(ranked, player.playerId);
    await attachNames(mine && mine.place > listSize ? [...top, mine.entry] : top);

    const list = top.length
      ? top.map((e, i) => `${i + 1}. ${e.name} (${formatValue(category, e.value, currencyName)})`).join('  ')
      : 'nobody yet';
    const you = mine ? ` | You: #${mine.place} (${formatValue(category, mine.entry.value, currencyName)})` : '';
    await player.pm(`${label}: ${list}${you}`);
  }
}

await main();
