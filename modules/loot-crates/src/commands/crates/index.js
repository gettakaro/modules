import { data, TakaroUserError } from '@takaro/helpers';
import {
  getCrates,
  requireCrate,
  getPrefix,
  getCurrencyName,
  getKeys,
  totalWeight,
  formatPercent,
  describeReward,
  argValue,
} from './crate-helpers.js';

async function main() {
  const { gameServerId, pog, arguments: args, module: mod } = data;
  const config = mod.userConfig;
  const prefix = await getPrefix(gameServerId);
  const currencyName = await getCurrencyName(gameServerId);
  const crates = getCrates(config);

  if (crates.length === 0) {
    throw new TakaroUserError('No crates are set up yet. Ask an admin to configure the loot-crates module.');
  }

  const wanted = argValue(args.crate);
  if (wanted) {
    const crate = requireCrate(config, wanted, prefix);
    const total = totalWeight(crate);
    const keys = await getKeys(crate, gameServerId, pog.playerId, mod.moduleId);
    const lines = (crate.rewards || [])
      .filter((reward) => Number(reward.weight) > 0)
      .map(
        (reward) =>
          `${formatPercent(Number(reward.weight), total)} [${reward.rarity || 'common'}] ${reward.name}: ${describeReward(reward, currencyName)}`,
      );
    const price = Number(crate.keyPrice) > 0 ? `${crate.keyPrice} ${currencyName}/key` : 'not for sale';
    await pog.pm(`${crate.name} crate (${price}, you have ${keys} key(s)). Odds:\n${lines.join('\n')}`);
    return;
  }

  const lines = [];
  for (const crate of crates) {
    const keys = await getKeys(crate, gameServerId, pog.playerId, mod.moduleId);
    const price = Number(crate.keyPrice) > 0 ? `${crate.keyPrice} ${currencyName}/key` : 'shop/admin only';
    lines.push(`${crate.name}: ${keys} key(s), ${price}`);
  }
  await pog.pm(
    `Loot crates:\n${lines.join('\n')}\nOdds: ${prefix}crates <name>. Buy: ${prefix}crate buy <name> [amount]. Open: ${prefix}crate open <name>`,
  );
}

await main();
