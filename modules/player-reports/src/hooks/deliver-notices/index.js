import { data } from '@takaro/helpers';
import { NOTICE_KEY, readJson, deleteVariable } from './report-helpers.js';

// Reporters who were offline when their report was closed get the notice on next login.
async function main() {
  const { gameServerId, player, module: mod } = data;
  if (!player) return;
  const moduleId = mod.moduleId;

  const notices = await readJson(gameServerId, moduleId, NOTICE_KEY, player.id, []);
  if (!Array.isArray(notices) || notices.length === 0) return;

  await deleteVariable(gameServerId, moduleId, NOTICE_KEY, player.id);
  for (const message of notices) {
    await player.pm(message);
  }
}

await main();
