import { data } from '@takaro/helpers';
import { getSetting, loadState, msLeft, formatDuration, formatAmount } from './crime-helpers.js';

async function main() {
  const { pog, player } = data;
  const currencyName = await getSetting('currencyName');
  const now = Date.now();
  const { state: s } = await loadState(pog.playerId, player.name);

  await pog.pm(
    `Crime: ${s.crimes} tries, ${s.crimesWon} got away. Earned ${formatAmount(s.crimeEarned)}, fines ${formatAmount(s.crimeFines)} ${currencyName}.`,
  );
  await pog.pm(
    `Robbery: ${s.robs} tries, ${s.robsWon} got away. Stolen ${formatAmount(s.stolen)}, fines ${formatAmount(s.robFines)} ${currencyName}.`,
  );
  await pog.pm(
    `Times robbed: ${s.timesRobbed}, lost ${formatAmount(s.lostToRobbers)}. Fines received ${formatAmount(s.finesReceived)} ${currencyName}.`,
  );

  const crimeWait = msLeft(s.crimeReadyAt, now);
  const robWait = msLeft(s.robReadyAt, now);
  const shield = msLeft(s.protectedUntil, now);
  const parts = [
    crimeWait > 0 ? `Crime in ${formatDuration(crimeWait)}` : 'Crime ready',
    robWait > 0 ? `Rob in ${formatDuration(robWait)}` : 'Rob ready',
  ];
  if (shield > 0) parts.push(`Protected from robbers for ${formatDuration(shield)}`);
  await pog.pm(`${parts.join(' | ')}.`);
}

await main();
