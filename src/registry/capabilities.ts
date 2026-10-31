/**
 * Informational only: Takaro derives its own required capabilities (gettakaro/takaro#4625).
 * The table mirrors Takaro's ACTION_CAPABILITIES for the game server controller methods modules call.
 */
import { ModuleVersion } from '../types/module.js';

const METHOD_CAPABILITIES: Record<string, string> = {
  GetPlayers: 'players.list',
  TeleportPlayer: 'players.teleport',
  GiveItem: 'items.give',
  GiveItems: 'items.give',
  SendMessage: 'chat.send',
  ExecuteCommand: 'console.execute',
  KickPlayer: 'moderation.kick',
  BanPlayer: 'moderation.ban',
  UnbanPlayer: 'moderation.unban',
  ListBans: 'moderation.listBans',
  Shutdown: 'server.shutdown',
  ListLocations: 'locations.list',
};

export function deriveRequiredCapabilities(version: ModuleVersion): string[] {
  const code = [
    ...version.commands,
    ...version.hooks,
    ...version.cronJobs,
    ...version.functions,
    ...(version.shopActions ?? []),
  ].map((entity) => entity.function);
  const capabilities = new Set<string>();
  for (const source of code) {
    for (const match of source.matchAll(/gameServerController([A-Za-z]+)/g)) {
      const capability = METHOD_CAPABILITIES[match[1]];
      if (capability) capabilities.add(capability);
    }
  }
  return [...capabilities].sort();
}
