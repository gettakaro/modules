import { data, takaro } from '@takaro/helpers';
import {
  getSlotConfig,
  getOnlinePlayers,
  hasReservedSlot,
  isExempt,
  isKickable,
  recordJoin,
  pickVictim,
  fillMessage,
  safeKick,
} from './slot-helpers.js';

async function main() {
  const { gameServerId, player, module: mod } = data;
  const config = mod.userConfig;
  const slots = getSlotConfig(config);

  if (!player) {
    console.log('reserved-slots: no player on this event, nothing to do');
    return;
  }

  await recordJoin(gameServerId, mod.moduleId, player.id, Date.now());

  if (!slots.enabled) {
    console.log('reserved-slots: maxPlayers is 0, module is off. Set "Max players" in the module config.');
    return;
  }

  let joiner = data.pog;
  if (!joiner) {
    joiner = (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, player.id)).data.data;
  }

  const online = await getOnlinePlayers(gameServerId);
  if (!online.some((pog) => pog.playerId === player.id)) online.push(joiner);

  const count = online.length;
  console.log(
    `reserved-slots: ${count} online, ${slots.publicSlots} public + ${slots.reservedSlots} reserved of ${slots.maxPlayers}`,
  );
  if (count <= slots.publicSlots) return;

  if (hasReservedSlot(joiner)) {
    const candidates = online.filter((pog) => pog.playerId !== player.id && isKickable(pog));
    const victim = await pickVictim(candidates, config.kickStrategy, gameServerId, mod.moduleId);
    if (!victim) {
      console.log(`reserved-slots: ${player.name} used a reserved slot; no regular player to kick`);
      return;
    }
    const reason = fillMessage(config.freedSlotMessage, config, slots);
    const kicked = await safeKick(gameServerId, victim.playerId, reason);
    if (kicked) {
      console.log(
        `reserved-slots: kicked player ${victim.playerId} (${config.kickStrategy}) to free a slot for ${player.name}`,
      );
    }
    return;
  }

  if (isExempt(joiner)) {
    console.log(`reserved-slots: ${player.name} is exempt, let in`);
    return;
  }

  if (!config.kickNonReservedJoiners) {
    console.log(`reserved-slots: ${player.name} joined the reserved zone; turning away is off`);
    return;
  }

  const reason = fillMessage(config.serverFullMessage, config, slots);
  const kicked = await safeKick(gameServerId, player.id, reason);
  if (kicked) console.log(`reserved-slots: turned away ${player.name}, server is in the reserved zone`);
}

await main();
