import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';
import { getSlotConfig, getOnlinePlayers, hasReservedSlot, isExempt } from './slot-helpers.js';

async function main() {
  const { pog, gameServerId, player, module: mod } = data;

  if (!checkPermission(pog, 'RESERVED_SLOTS_VIEW')) {
    throw new TakaroUserError('You do not have permission to view slot usage.');
  }

  const slots = getSlotConfig(mod.userConfig);
  if (!slots.enabled) {
    await player.pm('Reserved slots is off: set "Max players" in the module config first.');
    return;
  }

  const online = await getOnlinePlayers(gameServerId);
  const reserved = online.filter((p) => hasReservedSlot(p));
  const exempt = online.filter((p) => !hasReservedSlot(p) && isExempt(p));
  const regular = online.length - reserved.length - exempt.length;
  const zone = online.length > slots.publicSlots ? 'IN RESERVED ZONE' : 'public slots open';

  const lines = [
    `Slots: ${online.length}/${slots.maxPlayers} online (${zone})`,
    `Public: ${Math.min(online.length, slots.publicSlots)}/${slots.publicSlots} - Reserved: ${slots.reservedSlots} - Free: ${Math.max(0, slots.maxPlayers - online.length)}`,
    `Regular: ${regular} - Reserved holders: ${reserved.length} - Exempt staff: ${exempt.length}`,
  ];
  if (reserved.length > 0) {
    const res = await takaro.player.playerControllerSearch({
      filters: { id: reserved.map((p) => p.playerId) },
      limit: 100,
    });
    const names = new Map(res.data.data.map((p) => [p.id, p.name]));
    lines.push(`Reserved online: ${reserved.map((p) => names.get(p.playerId) ?? p.gameId).join(', ')}`);
  }

  for (const line of lines) {
    await player.pm(line);
  }
}

await main();
