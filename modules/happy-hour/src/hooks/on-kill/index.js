import { data, takaro } from '@takaro/helpers';
import {
  getState,
  isRunning,
  bonusAmount,
  vipPercent,
  economyEnabled,
  getTextContext,
  fill,
  pmGameId,
  formatMultiplier,
} from './hh-helpers.js';

async function giveDoubleDrop(gameServerId, player, gameId, config) {
  const items = (config.doubleDropItems || []).filter((entry) => entry && entry.item);
  const chance = Number(config.doubleDropChance) || 0;
  if (items.length === 0 || chance <= 0) return;
  if (Math.random() * 100 >= chance) return;

  const pick = items[Math.floor(Math.random() * items.length)];
  const amount = Number(pick.amount) > 0 ? Number(pick.amount) : 1;
  try {
    await takaro.gameserver.gameServerControllerGiveItem(gameServerId, player.id, {
      name: pick.item,
      amount,
      quality: pick.quality ?? '',
    });
  } catch (err) {
    console.error(`on-kill: could not give drop ${pick.item} to ${player.name}: ${err}`);
    return;
  }

  let itemName = pick.item;
  try {
    itemName = (await takaro.item.itemControllerFindOne(pick.item)).data.data.name || itemName;
  } catch (err) {
    console.log(`on-kill: item lookup for ${pick.item} failed, using id`);
  }
  console.log(`on-kill: drop ${amount}x ${itemName} for ${player.name}`);
  if (gameId) await pmGameId(gameServerId, gameId, fill(config.dropMessage, { amount, item: itemName }));
}

async function main() {
  const { gameServerId, eventData, player, module: mod } = data;
  const config = mod.userConfig;

  if (!player) {
    console.log('on-kill: no player on this event, nothing to do');
    return;
  }

  const state = await getState(gameServerId, mod.moduleId);
  if (!isRunning(state, Date.now())) {
    console.log('on-kill: no happy hour running');
    return;
  }

  const gameId = eventData?.player?.gameId;

  let pog = null;
  try {
    pog = (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, player.id)).data.data;
  } catch (err) {
    console.error(`on-kill: could not load pog for ${player.name}, no VIP bonus: ${err}`);
  }

  const amount = bonusAmount(config.killBaseReward, state.multiplier, vipPercent(pog));
  if (amount > 0 && (await economyEnabled(gameServerId))) {
    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, player.id, {
        currency: amount,
      });
      console.log(`on-kill: +${amount} bonus for ${player.name} (${eventData?.entity ?? 'entity'})`);
      if (config.notifyKillBonus && gameId) {
        const ctx = await getTextContext(gameServerId);
        await pmGameId(
          gameServerId,
          gameId,
          fill(config.killBonusMessage, { amount, currency: ctx.currency, multiplier: formatMultiplier(state.multiplier) }),
        );
      }
    } catch (err) {
      console.error(`on-kill: currency bonus for ${player.name} failed: ${err}`);
    }
  }

  await giveDoubleDrop(gameServerId, player, gameId, config);
}

await main();
