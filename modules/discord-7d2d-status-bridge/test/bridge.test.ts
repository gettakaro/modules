import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Client,
  EventOutputDTO,
  EventSearchInputAllowedFiltersEventNameEnum,
  HookTriggerDTOEventTypeEnum,
  ModuleOutputDTO,
} from '@takaro/apiclient';
import { createClient } from '../../../test/helpers/client.js';
import { MockServerContext, startMockServer, stopMockServer } from '../../../test/helpers/mock-server.js';
import {
  cleanupTestGameServers,
  cleanupTestModules,
  deleteModule,
  installModule,
  uninstallModule,
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');
const MODULE_TO_JSON_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'dist', 'scripts', 'module-to-json.js');
const TEST_MODULE_NAME = `qa-discord-7d2d-status-bridge-${process.pid}`;

interface WaitForBridgeEventOptions {
  eventName: EventSearchInputAllowedFiltersEventNameEnum;
  gameserverId: string;
  moduleId: string;
  after: Date;
  predicate?: (event: EventOutputDTO) => boolean;
  timeout?: number;
  pollInterval?: number;
}

async function waitForBridgeEvent(client: Client, options: WaitForBridgeEventOptions): Promise<EventOutputDTO> {
  const deadline = Date.now() + (options.timeout ?? 30000);
  const pollInterval = options.pollInterval ?? 1000;

  while (Date.now() < deadline) {
    const result = await client.event.eventControllerSearch({
      filters: {
        eventName: [options.eventName],
        gameserverId: [options.gameserverId],
        moduleId: [options.moduleId],
      },
      greaterThan: { createdAt: options.after.toISOString() },
    });
    const event = options.predicate
      ? result.data.data.find(options.predicate)
      : result.data.data[0];
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `Timed out waiting for event '${options.eventName}' for module '${options.moduleId}' `
      + `on gameserver '${options.gameserverId}'`,
  );
}

async function pushDisposableBridgeModule(client: Client): Promise<ModuleOutputDTO> {
  const tempFile = path.join(os.tmpdir(), `takaro-bridge-push-${process.pid}-${Date.now()}.json`);
  try {
    try {
      execFileSync(process.execPath, [MODULE_TO_JSON_SCRIPT, MODULE_DIR, tempFile], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const spawnErr = err as SpawnSyncReturns<Buffer>;
      const stderr = spawnErr.stderr?.toString().trim() ?? '';
      throw new Error(`module-to-json failed${stderr ? `:\n${stderr}` : ''}`);
    }

    const moduleJson = JSON.parse(fs.readFileSync(tempFile, 'utf-8')) as {
      name: string;
      supportedGames?: string[];
    };
    moduleJson.name = TEST_MODULE_NAME;
    moduleJson.supportedGames = [];

    const existing = await client.module.moduleControllerSearch({
      filters: { name: [TEST_MODULE_NAME] },
    });
    const existingModule = existing.data.data.find((candidate) => candidate.name === TEST_MODULE_NAME);
    if (existingModule) await client.module.moduleControllerRemove(existingModule.id);

    await client.module.moduleControllerImport(moduleJson);

    const imported = await client.module.moduleControllerSearch({
      filters: { name: [TEST_MODULE_NAME] },
    });
    const found = imported.data.data.find((candidate) => candidate.name === TEST_MODULE_NAME);
    if (!found) throw new Error(`Module '${TEST_MODULE_NAME}' not found after import`);
    return found;
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
}

describe('discord-7d2d-status-bridge integration', () => {
  let client: Client;
  let ctx: MockServerContext;
  let mod: ModuleOutputDTO;
  let installed = false;
  let playerName: string;
  let playerNames: string[];

  async function installWithConfig(userConfig: Record<string, unknown> = {}) {
    if (installed) {
      await uninstallModule(client, mod.id, ctx.gameServer.id);
      installed = false;
    }
    await installModule(client, mod.latestVersion.id, ctx.gameServer.id, {
      userConfig: { chatChannelId: '', monitoringChannelId: '', ...userConfig },
      systemConfig: { hooks: { discordChatRelay: { discordChannelId: '1' } } },
    });
    installed = true;
  }

  async function triggerHook(
    eventType: HookTriggerDTOEventTypeEnum,
    options: { playerId?: string; eventMeta?: Record<string, unknown>; expectedLog?: string } = {},
  ): Promise<string[]> {
    const beforeTrigger = new Date();
    await client.hook.hookControllerTrigger({
      gameServerId: ctx.gameServer.id,
      moduleId: mod.id,
      playerId: options.playerId,
      eventType,
      eventMeta: options.eventMeta ?? {},
    });
    const event = await waitForBridgeEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
      gameserverId: ctx.gameServer.id,
      moduleId: mod.id,
      after: beforeTrigger,
      predicate: options.expectedLog
        ? (candidate) => {
          const result = (candidate.meta as { result?: { logs?: Array<{ msg: string }> } }).result;
          return (result?.logs ?? []).some((entry) => entry.msg.includes(options.expectedLog!));
        }
        : undefined,
    });
    const result = (event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } }).result;
    const logs = (result?.logs ?? []).map((entry) => entry.msg);
    assert.equal(result?.success, true, `Expected hook '${eventType}' to succeed, logs: ${JSON.stringify(logs)}`);
    return logs;
  }

  async function triggerCronjob(name: string): Promise<string[]> {
    const cronjob = mod.latestVersion.cronJobs.find((candidate) => candidate.name === name);
    assert.ok(cronjob, `Expected cronjob '${name}' to exist`);
    const beforeTrigger = new Date();
    await client.cronjob.cronJobControllerTrigger({
      gameServerId: ctx.gameServer.id,
      moduleId: mod.id,
      cronjobId: cronjob.id,
    });
    const event = await waitForBridgeEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: ctx.gameServer.id,
      moduleId: mod.id,
      after: beforeTrigger,
    });
    const result = (event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } }).result;
    const logs = (result?.logs ?? []).map((entry) => entry.msg);
    assert.equal(result?.success, true, `Expected cronjob '${name}' to succeed, logs: ${JSON.stringify(logs)}`);
    return logs;
  }

  async function waitForOnlineCount(expected: number) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const result = await client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [ctx.gameServer.id], online: [true] },
      });
      if (result.data.data.length === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for ${expected} online players`);
  }

  function assertLogContains(logs: string[], expected: string) {
    assert.ok(
      logs.some((message) => message.includes(expected)),
      `Expected logs to contain ${JSON.stringify(expected)}, got: ${JSON.stringify(logs)}`,
    );
  }

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client, { serverNamePrefix: 'qa-discord-bridge-' });
    mod = await pushDisposableBridgeModule(client);
    playerNames = await Promise.all(ctx.players.map(async (playerOnGameserver) => {
      const player = await client.player.playerControllerGetOne(playerOnGameserver.playerId);
      return player.data.data.name;
    }));
    playerName = playerNames[0];
    try {
      await installWithConfig();
    } catch (err) {
      const response = (err as { response?: { status?: number; data?: unknown } }).response;
      throw new Error(`Bridge test installation failed (${response?.status ?? 'unknown'}): ${JSON.stringify(response?.data ?? {})}`);
    }
  });

  after(async () => {
    if (mod && ctx) {
      if (installed) {
        await uninstallModule(client, mod.id, ctx.gameServer.id).catch((err) => {
          const status = (err as { response?: { status?: number } }).response?.status;
          console.error(`Cleanup: failed to uninstall bridge test module (HTTP ${status ?? 'unknown'})`);
        });
      }
      await deleteModule(client, mod.id).catch((err) => {
        const status = (err as { response?: { status?: number } }).response?.status;
        console.error(`Cleanup: failed to delete bridge test module (HTTP ${status ?? 'unknown'})`);
      });
    }
    if (ctx) await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  it('imports under a disposable name and scopes hook events to that module', async () => {
    assert.equal(mod.name, TEST_MODULE_NAME);
    const logs = await triggerHook('player-connected', { playerId: ctx.players[0].playerId });
    assert.ok(logs.length > 0);
  });

  it('uses English monitoring messages by default', async () => {
    await installWithConfig();

    const joinLogs = await triggerHook('player-connected', { playerId: ctx.players[0].playerId });
    const leaveLogs = await triggerHook('player-disconnected', { playerId: ctx.players[0].playerId });
    const deathLogs = await triggerHook('player-death', { playerId: ctx.players[0].playerId });
    const reasonLogs = await triggerHook('player-death', {
      playerId: ctx.players[0].playerId,
      eventMeta: { reason: 'zombie' },
    });

    assertLogContains(joinLogs, `${playerName} joined the game.`);
    assertLogContains(leaveLogs, `${playerName} left the game.`);
    assertLogContains(deathLogs, `${playerName} died.`);
    assertLogContains(reasonLogs, `${playerName} died: zombie`);
  });

  it('uses the exact Polish issue wording when selected', async () => {
    await installWithConfig({ language: 'pl' });

    const joinLogs = await triggerHook('player-connected', { playerId: ctx.players[0].playerId });
    const leaveLogs = await triggerHook('player-disconnected', { playerId: ctx.players[0].playerId });
    const deathLogs = await triggerHook('player-death', { playerId: ctx.players[0].playerId });
    const reasonLogs = await triggerHook('player-death', {
      playerId: ctx.players[0].playerId,
      eventMeta: { reason: 'zombie' },
    });

    assertLogContains(joinLogs, `${playerName} dołącza do gry.`);
    assertLogContains(leaveLogs, `${playerName} opuszcza grę.`);
    assertLogContains(deathLogs, `${playerName} nie żyje.`);
    assertLogContains(reasonLogs, `${playerName} nie żyje: zombie`);
  });

  it('prefers non-empty custom templates and warns about unknown placeholders', async () => {
    await installWithConfig({
      language: 'pl',
      joinMessageTemplate: 'Welcome {player} {mystery}',
    });

    const logs = await triggerHook('player-connected', { playerId: ctx.players[0].playerId });

    assertLogContains(logs, `Welcome ${playerName} {mystery}`);
    assertLogContains(logs, 'unknown template placeholders: {mystery}');
  });

  it('falls back from an empty override and localizes a missing player name', async () => {
    await installWithConfig({
      language: 'pl',
      joinMessageTemplate: '',
      unknownPlayerText: 'Nieznany gracz',
    });

    const logs = await triggerHook('player-connected');

    assertLogContains(logs, 'Nieznany gracz dołącza do gry.');
  });

  it('announces server online and offline states in English by default', async () => {
    await installWithConfig();
    const timestamp = new Date().toISOString();

    const onlineLogs = await triggerHook('server-status-changed', {
      eventMeta: { status: 'online', timestamp },
    });
    const offlineLogs = await triggerHook('server-status-changed', {
      eventMeta: { status: 'offline', timestamp, details: 'test outage' },
    });

    assertLogContains(onlineLogs, 'Server starting...');
    assertLogContains(offlineLogs, 'Server is offline.');
  });

  it('localizes server states and supports a server-name override', async () => {
    await installWithConfig({
      language: 'pl',
      serverStartingMessageTemplate: 'Custom {serverName} online',
    });
    const timestamp = new Date().toISOString();

    const onlineLogs = await triggerHook('server-status-changed', {
      eventMeta: { status: 'online', timestamp },
    });
    const offlineLogs = await triggerHook('server-status-changed', {
      eventMeta: { status: 'offline', timestamp },
    });

    assertLogContains(onlineLogs, `Custom ${ctx.gameServer.name} online`);
    assertLogContains(offlineLogs, 'Serwer wyłączony.');
  });

  it('ignores unknown server states with a diagnostic log', async () => {
    await installWithConfig();

    const logs = await triggerHook('server-status-changed', {
      eventMeta: { status: 'maintenance', timestamp: new Date().toISOString() },
    });

    assertLogContains(logs, 'ignoring unsupported server status: maintenance');
    assert.ok(!logs.some((message) => message.includes('skipped message:')));
  });

  it('renders count, server name, unknown time, and an ordered player list', async () => {
    await installWithConfig({
      updateStatusMessage: false,
      statusTemplate: '{onlinePlayers} online | {serverName} | Day {day} | {time}\nPlayers:\n{playerList}',
    });

    const logs = await triggerCronjob('updateStatus');
    const expectedPlayers = [...playerNames].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

    assertLogContains(logs, `${playerNames.length} online`);
    assertLogContains(logs, `Day ?`);
    assertLogContains(logs, ctx.gameServer.name);
    assertLogContains(logs, `Players:\n${expectedPlayers.join('\n')}`);
  });

  it('uses localized or overridden empty-player-list text', async () => {
    await ctx.server.executeConsoleCommand('disconnectAll');
    await waitForOnlineCount(0);
    try {
      await installWithConfig({
        language: 'pl',
        updateStatusMessage: false,
        statusTemplate: 'Lista:\n{playerList}',
        emptyPlayerListText: 'Nikt teraz nie gra',
      });

      const logs = await triggerCronjob('updateStatus');

      assertLogContains(logs, 'Lista:\nNikt teraz nie gra');
    } finally {
      await ctx.server.executeConsoleCommand('connectAll');
      await waitForOnlineCount(playerNames.length);
    }
  });

  it('relays global game chat with sanitized Discord mentions', async () => {
    await installWithConfig();

    const logs = await triggerHook('chat-message', {
      playerId: ctx.players[0].playerId,
      eventMeta: { channel: 'global', msg: '@everyone hello' },
    });

    assertLogContains(logs, `**${playerName}:** @\u200beveryone hello`);
    assert.ok(!logs.some((message) => message.includes('skipped message:') && message.includes('@everyone')));
  });

  it('ignores private chat and Discord relay echoes', async () => {
    await installWithConfig();

    const privateLogs = await triggerHook('chat-message', {
      playerId: ctx.players[0].playerId,
      eventMeta: { channel: 'team', msg: 'private message' },
    });
    const echoLogs = await triggerHook('chat-message', {
      playerId: ctx.players[0].playerId,
      eventMeta: { channel: 'global', msg: '[Discord] Alice: echo' },
    });

    assert.ok(!privateLogs.some((message) => message.includes('skipped message:')));
    assert.ok(!echoLogs.some((message) => message.includes('skipped message:')));
  });

  it('ignores Discord bots and relays Discord users into the game', async () => {
    await installWithConfig();

    const botLogs = await triggerHook('discord-message', {
      eventMeta: {
        msg: 'bot message',
        author: { id: 'bot', username: 'BridgeBot', displayName: 'Bridge Bot', isBot: true, isTakaroBot: false },
        channel: { id: '1', name: 'test' },
        timestamp: new Date().toISOString(),
      },
    });
    const userLogs = await triggerHook('discord-message', {
      expectedLog: 'relayed Discord message to game: [Discord] Alice: hello game',
      eventMeta: {
        msg: 'hello game',
        author: { id: 'user', username: 'Alice', displayName: 'Alice', isBot: false, isTakaroBot: false },
        channel: { id: '1', name: 'test' },
        timestamp: new Date().toISOString(),
      },
    });

    assert.ok(!botLogs.some((message) => message.includes('/message')));
    assertLogContains(userLogs, 'relayed Discord message to game: [Discord] Alice: hello game');
  });
});
