import { data, TakaroUserError, checkPermission } from '@takaro/helpers';
import { PERM_MANAGE, getOpenIndex, getPrefix, timeAgo } from './report-helpers.js';

const PAGE_SIZE = 8;

async function main() {
  const { gameServerId, player, pog, module: mod } = data;
  if (!checkPermission(pog, PERM_MANAGE)) {
    throw new TakaroUserError('You do not have permission to manage reports.');
  }

  const prefix = await getPrefix(gameServerId);
  const open = await getOpenIndex(gameServerId, mod.moduleId);
  if (open.length === 0) {
    await player.pm('No open reports.');
    return;
  }

  const newest = [...open].sort((a, b) => b.id - a.id).slice(0, PAGE_SIZE);
  await player.pm(`Open reports: ${open.length}${open.length > PAGE_SIZE ? ` (newest ${PAGE_SIZE})` : ''}`);
  for (const t of newest) {
    const about = t.targetName ? ` -> ${t.targetName}` : '';
    await player.pm(`#${t.id} ${t.reporterName}${about}: ${t.reason} (${timeAgo(t.createdAt)})`);
  }
  await player.pm(`Details: ${prefix}reportview <id> | Close: ${prefix}reportclose <id> [note]`);
}

await main();
