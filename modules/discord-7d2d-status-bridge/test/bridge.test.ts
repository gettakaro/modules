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
const DISCORD_TEST_CHANNEL_ID = process.env.TAKARO_DISCORD_TEST_CHANNEL_ID?.trim();
const DISCORD_FORBIDDEN_CHANNEL_ID = process.env.TAKARO_DISCORD_FORBIDDEN_CHANNEL_ID?.trim();
const DISCORD_NOT_FOUND_CHANNEL_ID = process.env.TAKARO_DISCORD_NOT_FOUND_CHANNEL_ID?.trim();
const LIVE_DISCORD_CHANNEL_IDS = [DISCORD_TEST_CHANNEL_ID, DISCORD_FORBIDDEN_CHANNEL_ID, DISCORD_NOT_FOUND_CHANNEL_ID]
  .filter((channelId): channelId is string => Boolean(channelId));
if (new Set(LIVE_DISCORD_CHANNEL_IDS).size !== LIVE_DISCORD_CHANNEL_IDS.length) {
  throw new Error('Live Discord smoke gates require distinct channel IDs');
}

interface BridgeExecutionResult {
  success: boolean;
  logs: string[];
}

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

async function setModuleVariable(
  client: Client,
  gameServerId: string,
  moduleId: string,
  key: string,
  value: unknown,
) {
  const serialized = JSON.stringify(value);
  const existing = await client.variable.variableControllerSearch({
    filters: { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] },
  });
  if (existing.data.data[0]) {
    await client.variable.variableControllerUpdate(existing.data.data[0].id, { value: serialized });
  } else {
    await client.variable.variableControllerCreate({ key, value: serialized, gameServerId, moduleId });
  }
}

describe('discord-7d2d-status-bridge integration', () => {
  let client: Client;
  let ctx: MockServerContext;
  let noticeCtx: MockServerContext;
  let mod: ModuleOutputDTO;
  let installed = false;
  let noticeInstalled = false;
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

  async function installNoticeWithConfig(userConfig: Record<string, unknown> = {}) {
    if (noticeInstalled) {
      await uninstallModule(client, mod.id, noticeCtx.gameServer.id);
      noticeInstalled = false;
    }
    await installModule(client, mod.latestVersion.id, noticeCtx.gameServer.id, {
      userConfig: { chatChannelId: '', monitoringChannelId: '', ...userConfig },
      systemConfig: { hooks: { discordChatRelay: { discordChannelId: '1' } } },
    });
    noticeInstalled = true;
  }

  async function triggerHookExecution(
    eventType: HookTriggerDTOEventTypeEnum,
    options: {
      playerId?: string;
      eventMeta?: Record<string, unknown>;
      expectedLog?: string;
      serverContext?: MockServerContext;
    } = {},
  ): Promise<BridgeExecutionResult> {
    const hook = mod.latestVersion.hooks.find((candidate) => candidate.eventType === eventType);
    assert.ok(hook, `Expected hook for '${eventType}' to exist`);
    const target = options.serverContext ?? ctx;
    const beforeTrigger = new Date();
    await client.hook.hookControllerTrigger({
      gameServerId: target.gameServer.id,
      moduleId: mod.id,
      playerId: options.playerId,
      eventType,
      eventMeta: options.eventMeta ?? {},
    });
    const event = await waitForBridgeEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
      gameserverId: target.gameServer.id,
      moduleId: mod.id,
      after: beforeTrigger,
      predicate: (candidate) => {
        const meta = candidate.meta as { hook?: { id?: string }; result?: { logs?: Array<{ msg: string }> } };
        if (meta.hook?.id !== hook.id) return false;
        if (options.expectedLog) {
          const result = (candidate.meta as { result?: { logs?: Array<{ msg: string }> } }).result;
          return (result?.logs ?? []).some((entry) => entry.msg.includes(options.expectedLog!));
        }
        return true;
      },
    });
    const result = (event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } }).result;
    const logs = (result?.logs ?? []).map((entry) => entry.msg);
    return { success: result?.success ?? false, logs };
  }

  async function triggerHook(
    eventType: HookTriggerDTOEventTypeEnum,
    options: {
      playerId?: string;
      eventMeta?: Record<string, unknown>;
      expectedLog?: string;
      serverContext?: MockServerContext;
    } = {},
  ): Promise<string[]> {
    const execution = await triggerHookExecution(eventType, options);
    assert.equal(execution.success, true, `Expected hook '${eventType}' to succeed, logs: ${JSON.stringify(execution.logs)}`);
    return execution.logs;
  }

  async function triggerCronjobExecution(name: string): Promise<BridgeExecutionResult> {
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
      predicate: (candidate) => (
        (candidate.meta as { cronjob?: { id?: string } }).cronjob?.id === cronjob.id
      ),
    });
    const result = (event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } }).result;
    const logs = (result?.logs ?? []).map((entry) => entry.msg);
    return { success: result?.success ?? false, logs };
  }

  async function triggerCronjob(name: string): Promise<string[]> {
    const execution = await triggerCronjobExecution(name);
    assert.equal(execution.success, true, `Expected cronjob '${name}' to succeed, logs: ${JSON.stringify(execution.logs)}`);
    return execution.logs;
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
    noticeCtx = await startMockServer(client, { serverNamePrefix: 'qa-discord-notice-', totalPlayers: 1 });
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
      if (noticeInstalled && noticeCtx) {
        await uninstallModule(client, mod.id, noticeCtx.gameServer.id).catch((err) => {
          const status = (err as { response?: { status?: number } }).response?.status;
          console.error(`Cleanup: failed to uninstall bridge notice test module (HTTP ${status ?? 'unknown'})`);
        });
      }
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
    if (noticeCtx) await stopMockServer(noticeCtx.server, client, noticeCtx.gameServer.id);
  });

  it('imports under a disposable name and scopes hook events to that module', async () => {
    assert.equal(mod.name, TEST_MODULE_NAME);
    const logs = await triggerHook('player-connected', { playerId: ctx.players[0].playerId });
    assert.ok(logs.length > 0);
  });

  it('checks blood moon transitions every minute without changing status updates', () => {
    const bloodMoonMonitor = mod.latestVersion.cronJobs.find((cronjob) => cronjob.name === 'bloodMoonMonitor');
    const updateStatus = mod.latestVersion.cronJobs.find((cronjob) => cronjob.name === 'updateStatus');

    assert.equal(bloodMoonMonitor?.temporalValue, '* * * * *');
    assert.equal(updateStatus?.temporalValue, '*/5 * * * *');
  });

  it('imports the opt-in private Blood Moon notice config with safe defaults', () => {
    const configSchema = JSON.parse(mod.latestVersion.configSchema) as {
      properties?: Record<string, { type?: string; default?: unknown; maxLength?: number; description?: string }>;
    };
    const enabled = configSchema.properties?.privateBloodMoonNoticeOnFirstJoin;
    const message = configSchema.properties?.privateBloodMoonTodayMessage;

    assert.deepEqual(
      { type: enabled?.type, default: enabled?.default },
      { type: 'boolean', default: false },
    );
    assert.ok(enabled?.description, 'Expected the private notice toggle to have a description');
    assert.deepEqual(
      { type: message?.type, maxLength: message?.maxLength, default: message?.default },
      { type: 'string', maxLength: 500, default: '' },
    );
    assert.ok(message?.description, 'Expected the private notice message to have a description');
  });

  it('privately sends the exact English Blood Moon Today wording to the first online player', async () => {
    await installNoticeWithConfig({
      monitorJoins: false,
      privateBloodMoonNoticeOnFirstJoin: true,
    });
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState', 'today:7');

    const logs = await triggerHook('player-connected', {
      playerId: noticeCtx.players[0].playerId,
      serverContext: noticeCtx,
    });

    assertLogContains(logs, `/gameserver/${noticeCtx.gameServer.id}/message 200 OK`);
    assertLogContains(logs, 'private blood moon first-join notice sent: Today is the Blood Moon day...');
    assert.ok(
      !logs.some((message) => message.includes(`/gameserver/${noticeCtx.gameServer.id}/command`)),
      `Join notice must use persisted phase without executing gettime: ${JSON.stringify(logs)}`,
    );
  });

  it('uses the exact Polish Blood Moon Today wording for a persisted start phase', async () => {
    await installNoticeWithConfig({ language: 'pl', privateBloodMoonNoticeOnFirstJoin: true });
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState', 'start:7');

    const logs = await triggerHook('player-connected', {
      playerId: noticeCtx.players[0].playerId,
      serverContext: noticeCtx,
    });

    assertLogContains(logs, `/gameserver/${noticeCtx.gameServer.id}/message 200 OK`);
    assertLogContains(logs, 'private blood moon first-join notice sent: Dzisiaj zapowiadają Krwawy Księżyc...');
  });

  it('supports a non-empty private Blood Moon message override', async () => {
    await installNoticeWithConfig({
      privateBloodMoonNoticeOnFirstJoin: true,
      privateBloodMoonTodayMessage: 'Custom private Blood Moon warning',
    });
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState', 'today:7');

    const logs = await triggerHook('player-connected', {
      playerId: noticeCtx.players[0].playerId,
      serverContext: noticeCtx,
    });

    assertLogContains(logs, 'private blood moon first-join notice sent: Custom private Blood Moon warning');
  });

  it('does not privately notify when the option is disabled by default', async () => {
    await installNoticeWithConfig();
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState', 'today:7');

    const logs = await triggerHook('player-connected', {
      playerId: noticeCtx.players[0].playerId,
      serverContext: noticeCtx,
    });

    assert.ok(!logs.some((message) => message.includes('private blood moon first-join notice sent:')));
    assert.ok(!logs.some((message) => message.includes(`/gameserver/${noticeCtx.gameServer.id}/message`)));
  });

  it('does not privately notify for missing, normal, or ended Blood Moon state', async () => {
    await installNoticeWithConfig({ privateBloodMoonNoticeOnFirstJoin: true });
    for (const phase of [null, 'normal:6', 'end:7']) {
      await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState', phase);

      const logs = await triggerHook('player-connected', {
        playerId: noticeCtx.players[0].playerId,
        serverContext: noticeCtx,
      });

      assert.ok(
        !logs.some((message) => message.includes('private blood moon first-join notice sent:')),
        `Phase ${JSON.stringify(phase)} must not send a private notice: ${JSON.stringify(logs)}`,
      );
      assert.ok(
        !logs.some((message) => message.includes(`/gameserver/${noticeCtx.gameServer.id}/message`)),
        `Phase ${JSON.stringify(phase)} must not call the game message API: ${JSON.stringify(logs)}`,
      );
    }
  });

  it('does not privately notify a missing player', async () => {
    await installNoticeWithConfig({ privateBloodMoonNoticeOnFirstJoin: true });
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState', 'today:7');

    const logs = await triggerHook('player-connected', { serverContext: noticeCtx });

    assert.ok(!logs.some((message) => message.includes('private blood moon first-join notice sent:')));
    assert.ok(!logs.some((message) => message.includes(`/gameserver/${noticeCtx.gameServer.id}/message`)));
  });

  it('does not privately notify when more than one player is online', async () => {
    await installWithConfig({ privateBloodMoonNoticeOnFirstJoin: true });
    await setModuleVariable(client, ctx.gameServer.id, mod.id, 'discord7d2d:bloodState', 'today:7');

    const logs = await triggerHook('player-connected', { playerId: ctx.players[0].playerId });

    assert.ok(!logs.some((message) => message.includes('private blood moon first-join notice sent:')));
    assert.ok(!logs.some((message) => message.includes(`/gameserver/${ctx.gameServer.id}/message`)));
  });

  it('[live smoke] delivers the private notice before a configured Discord join failure remains visible', {
    skip: DISCORD_FORBIDDEN_CHANNEL_ID ? false : 'Live smoke gate skipped: set TAKARO_DISCORD_FORBIDDEN_CHANNEL_ID',
  }, async () => {
    assert.ok(DISCORD_FORBIDDEN_CHANNEL_ID);
    await installNoticeWithConfig({
      monitoringChannelId: DISCORD_FORBIDDEN_CHANNEL_ID,
      privateBloodMoonNoticeOnFirstJoin: true,
    });
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState', 'today:7');

    const execution = await triggerHookExecution('player-connected', {
      playerId: noticeCtx.players[0].playerId,
      serverContext: noticeCtx,
    });

    assert.equal(execution.success, false, `Configured Discord failure must fail the hook: ${JSON.stringify(execution.logs)}`);
    assertLogContains(execution.logs, `/gameserver/${noticeCtx.gameServer.id}/message 200 OK`);
    assertLogContains(execution.logs, 'private blood moon first-join notice sent: Today is the Blood Moon day...');
    assertLogContains(execution.logs, `Takaro or Discord refused delivery to channel ${DISCORD_FORBIDDEN_CHANNEL_ID}`);
  });

  it('polls blood moon time without loading players or server metadata', async () => {
    const execution = await triggerCronjobExecution('bloodMoonMonitor');

    assert.equal(execution.success, true, `Expected blood moon polling to succeed, logs: ${JSON.stringify(execution.logs)}`);
    assert.ok(
      !execution.logs.some((message) => message.includes('POST /gameserver/player/search')),
      `Blood moon polling must not search players: ${JSON.stringify(execution.logs)}`,
    );
    assert.ok(
      !execution.logs.some((message) => message.includes(`GET /gameserver/${ctx.gameServer.id}`)),
      `Blood moon polling must not fetch server metadata: ${JSON.stringify(execution.logs)}`,
    );
  });

  it('does not rewrite an unchanged blood moon phase', async () => {
    await triggerCronjob('bloodMoonMonitor');
    const repeated = await triggerCronjobExecution('bloodMoonMonitor');

    assert.equal(repeated.success, true, `Expected repeated blood moon polling to succeed, logs: ${JSON.stringify(repeated.logs)}`);
    assert.ok(
      !repeated.logs.some((message) => (
        /POST \/variables(?:\s|$)/.test(message) || message.includes('PUT /variables/')
      )),
      `An unchanged blood moon phase must not be written again: ${JSON.stringify(repeated.logs)}`,
    );
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

  it('[live smoke] delivers a status message through the real Takaro Discord API', {
    skip: DISCORD_TEST_CHANNEL_ID ? false : 'Live smoke gate skipped: set TAKARO_DISCORD_TEST_CHANNEL_ID',
  }, async () => {
    assert.ok(DISCORD_TEST_CHANNEL_ID);
    await installWithConfig({
      monitoringChannelId: DISCORD_TEST_CHANNEL_ID,
      updateStatusMessage: false,
    });

    const execution = await triggerCronjobExecution('updateStatus');

    assert.equal(execution.success, true, `Expected Discord delivery to succeed, logs: ${JSON.stringify(execution.logs)}`);
    assert.ok(
      !execution.logs.some((message) => message.includes('skipped message:')),
      `A skipped message is not Discord delivery evidence: ${JSON.stringify(execution.logs)}`,
    );
    assertLogContains(execution.logs, `/discord/channels/${DISCORD_TEST_CHANNEL_ID}/message 200 OK`);
  });

  it('[live smoke] explains both Takaro and Discord authorization for a forbidden monitoring channel', {
    skip: DISCORD_FORBIDDEN_CHANNEL_ID ? false : 'Live smoke gate skipped: set TAKARO_DISCORD_FORBIDDEN_CHANNEL_ID',
  }, async () => {
    assert.ok(DISCORD_FORBIDDEN_CHANNEL_ID);
    await installWithConfig({
      monitoringChannelId: DISCORD_FORBIDDEN_CHANNEL_ID,
      updateStatusMessage: false,
    });

    const execution = await triggerCronjobExecution('updateStatus');

    assert.equal(execution.success, false, `Expected Discord delivery to fail, logs: ${JSON.stringify(execution.logs)}`);
    const diagnostic = execution.logs.find((message) => (
      message.includes(DISCORD_FORBIDDEN_CHANNEL_ID) && message.includes('normal text channel')
    ));
    assert.ok(diagnostic, `Expected an actionable diagnostic naming the forbidden channel, logs: ${JSON.stringify(execution.logs)}`);
    assert.match(diagnostic, /normal text channel/);
    assert.match(diagnostic, /Takaro or Discord/);
    assert.match(diagnostic, /guild is enabled and authorized in Takaro/);
    assert.match(diagnostic, /View Channel/);
    assert.match(diagnostic, /Send Messages/);
    assert.match(diagnostic, /Read Message History/);
    assert.match(diagnostic, /private or archived threads may still reject the bot/);
  });

  it('[live smoke] does not replace a persistent status message when its update is forbidden', {
    skip: DISCORD_FORBIDDEN_CHANNEL_ID ? false : 'Live smoke gate skipped: set TAKARO_DISCORD_FORBIDDEN_CHANNEL_ID',
  }, async () => {
    assert.ok(DISCORD_FORBIDDEN_CHANNEL_ID);
    const previousMessageId = '999999999999999999';
    await installWithConfig({ monitoringChannelId: DISCORD_FORBIDDEN_CHANNEL_ID });
    await setModuleVariable(
      client,
      ctx.gameServer.id,
      mod.id,
      `discord7d2d:statusMessage:${DISCORD_FORBIDDEN_CHANNEL_ID}`,
      previousMessageId,
    );

    const execution = await triggerCronjobExecution('updateStatus');

    assert.equal(execution.success, false, `Expected Discord update to fail, logs: ${JSON.stringify(execution.logs)}`);
    assertLogContains(
      execution.logs,
      `/discord/channels/${DISCORD_FORBIDDEN_CHANNEL_ID}/messages/${previousMessageId}`,
    );
    assert.equal(
      execution.logs.filter((message) => (
        message.includes(`POST /discord/channels/${DISCORD_FORBIDDEN_CHANNEL_ID}/message`)
      )).length,
      0,
      `A forbidden update must not send a replacement message: ${JSON.stringify(execution.logs)}`,
    );
    const diagnostic = execution.logs.find((message) => message.includes('Takaro or Discord'));
    assert.ok(diagnostic, `Expected an authorization-layer diagnostic, logs: ${JSON.stringify(execution.logs)}`);
    assert.match(diagnostic, /guild is enabled and authorized in Takaro/);
  });

  it('[live smoke] does not replace a persistent status message for a generic channel 404', {
    skip: DISCORD_NOT_FOUND_CHANNEL_ID ? false : 'Live smoke gate skipped: set TAKARO_DISCORD_NOT_FOUND_CHANNEL_ID',
  }, async () => {
    assert.ok(DISCORD_NOT_FOUND_CHANNEL_ID);
    const previousMessageId = '888888888888888888';
    await installWithConfig({ monitoringChannelId: DISCORD_NOT_FOUND_CHANNEL_ID });
    await setModuleVariable(
      client,
      ctx.gameServer.id,
      mod.id,
      `discord7d2d:statusMessage:${DISCORD_NOT_FOUND_CHANNEL_ID}`,
      previousMessageId,
    );

    const execution = await triggerCronjobExecution('updateStatus');

    assert.equal(execution.success, false, `Expected Discord update to fail, logs: ${JSON.stringify(execution.logs)}`);
    assertLogContains(execution.logs, 'HTTP 404');
    assert.equal(
      execution.logs.filter((message) => (
        message.includes(`POST /discord/channels/${DISCORD_NOT_FOUND_CHANNEL_ID}/message`)
      )).length,
      0,
      `A generic channel 404 must not send a replacement message: ${JSON.stringify(execution.logs)}`,
    );
    assert.ok(
      !execution.logs.some((message) => message.includes('prior Discord status message') && message.includes('is missing')),
      `A generic channel 404 must not be described as a missing prior message: ${JSON.stringify(execution.logs)}`,
    );
    const diagnostic = execution.logs.find((message) => (
      message.includes(`channel ${DISCORD_NOT_FOUND_CHANNEL_ID} or its guild`)
    ));
    assert.ok(diagnostic, `Expected a channel-or-guild 404 diagnostic, logs: ${JSON.stringify(execution.logs)}`);
    assert.match(diagnostic, /not found or is unavailable/);
    assert.doesNotMatch(diagnostic, /Unknown Message/);
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
