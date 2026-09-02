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
const TEST_TIME_DAY_6_START = 'say Day 6 22:00';
const TEST_TIME_DAY_7_NOON = 'say Day 7 12:00';
const TEST_TIME_DAY_7_START = 'say Day 7 22:00';
const TEST_TIME_DAY_8_AFTER_END = 'say Day 8 05:00';
const TEST_TIME_COMMANDS = [TEST_TIME_DAY_6_START, TEST_TIME_DAY_7_NOON, TEST_TIME_DAY_7_START, TEST_TIME_DAY_8_AFTER_END];
const dormantCronDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
const TEST_DORMANT_CRON = [
  dormantCronDate.getUTCMinutes(),
  dormantCronDate.getUTCHours(),
  dormantCronDate.getUTCDate(),
  dormantCronDate.getUTCMonth() + 1,
  '*',
].join(' ');
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
      versions: Array<{
        configSchema: string;
        cronJobs: Array<{ name: string; temporalValue: string }>;
      }>;
    };
    moduleJson.name = TEST_MODULE_NAME;
    moduleJson.supportedGames = [];
    const configSchema = JSON.parse(moduleJson.versions[0].configSchema) as {
      properties: { timeConsoleCommand: { enum: string[] } };
    };
    configSchema.properties.timeConsoleCommand.enum.push(...TEST_TIME_COMMANDS);
    moduleJson.versions[0].configSchema = JSON.stringify(configSchema);
    const bloodMoonMonitor = moduleJson.versions[0].cronJobs.find((cronjob) => cronjob.name === 'bloodMoonMonitor');
    assert.ok(bloodMoonMonitor, 'Expected disposable import to contain bloodMoonMonitor');
    bloodMoonMonitor.temporalValue = TEST_DORMANT_CRON;

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

async function deleteModuleVariable(
  client: Client,
  gameServerId: string,
  moduleId: string,
  key: string,
) {
  const existing = await client.variable.variableControllerSearch({
    filters: { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] },
  });
  await Promise.all(
    existing.data.data.map((variable) => client.variable.variableControllerDelete(variable.id)),
  );
}

async function readModuleVariable(
  client: Client,
  gameServerId: string,
  moduleId: string,
  key: string,
) {
  const existing = await client.variable.variableControllerSearch({
    filters: { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] },
  });
  const record = existing.data.data[0];
  return record ? JSON.parse(record.value) as unknown : undefined;
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

  async function triggerCronjobExecution(
    name: string,
    serverContext: MockServerContext = ctx,
  ): Promise<BridgeExecutionResult> {
    const cronjob = mod.latestVersion.cronJobs.find((candidate) => candidate.name === name);
    assert.ok(cronjob, `Expected cronjob '${name}' to exist`);
    const beforeTrigger = new Date();
    await client.cronjob.cronJobControllerTrigger({
      gameServerId: serverContext.gameServer.id,
      moduleId: mod.id,
      cronjobId: cronjob.id,
    });
    const event = await waitForBridgeEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: serverContext.gameServer.id,
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

  async function triggerCronjob(
    name: string,
    serverContext: MockServerContext = ctx,
  ): Promise<string[]> {
    const execution = await triggerCronjobExecution(name, serverContext);
    assert.equal(execution.success, true, `Expected cronjob '${name}' to succeed, logs: ${JSON.stringify(execution.logs)}`);
    return execution.logs;
  }

  async function triggerConcurrentCronjobExecutions(
    name: string,
    count: number,
    serverContext: MockServerContext = ctx,
  ): Promise<BridgeExecutionResult[]> {
    const cronjob = mod.latestVersion.cronJobs.find((candidate) => candidate.name === name);
    assert.ok(cronjob, `Expected cronjob '${name}' to exist`);
    const beforeTrigger = new Date();
    await Promise.all(Array.from({ length: count }, () => (
      client.cronjob.cronJobControllerTrigger({
        gameServerId: serverContext.gameServer.id,
        moduleId: mod.id,
        cronjobId: cronjob.id,
      })
    )));

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const events = await client.event.eventControllerSearch({
        filters: {
          eventName: [EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted],
          gameserverId: [serverContext.gameServer.id],
          moduleId: [mod.id],
        },
        greaterThan: { createdAt: beforeTrigger.toISOString() },
      });
      const matching = events.data.data.filter((candidate) => (
        (candidate.meta as { cronjob?: { id?: string } }).cronjob?.id === cronjob.id
      ));
      if (matching.length >= count) {
        return matching.slice(0, count).map((event) => {
          const result = (event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } }).result;
          return {
            success: result?.success ?? false,
            logs: (result?.logs ?? []).map((entry) => entry.msg),
          };
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for ${count} concurrent '${name}' executions`);
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
    const manifest = JSON.parse(fs.readFileSync(path.join(MODULE_DIR, 'module.json'), 'utf-8')) as {
      cronJobs: Record<string, { temporalValue: string }>;
    };
    const importedBloodMoonMonitor = mod.latestVersion.cronJobs.find((cronjob) => cronjob.name === 'bloodMoonMonitor');

    assert.equal(manifest.cronJobs.bloodMoonMonitor.temporalValue, '* * * * *');
    assert.equal(manifest.cronJobs.updateStatus.temporalValue, '*/5 * * * *');
    assert.equal(importedBloodMoonMonitor?.temporalValue, TEST_DORMANT_CRON);
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
    const range = configSchema.properties?.bloodMoonRangeDays;
    assert.deepEqual(
      { type: range?.type, default: range?.default },
      { type: 'integer', default: 0 },
    );
    assert.match(range?.description ?? '', /BloodMoonRange/i);
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

  it('does not privately notify when the Blood Moon state variable is absent', async () => {
    await installNoticeWithConfig({ privateBloodMoonNoticeOnFirstJoin: true });
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState');
    const variables = await client.variable.variableControllerSearch({
      filters: {
        key: ['discord7d2d:bloodState'],
        gameServerId: [noticeCtx.gameServer.id],
        moduleId: [mod.id],
      },
    });
    assert.equal(variables.data.data.length, 0, 'Expected no persisted Blood Moon state record');

    const logs = await triggerHook('player-connected', {
      playerId: noticeCtx.players[0].playerId,
      serverContext: noticeCtx,
    });

    assert.ok(!logs.some((message) => message.includes('private blood moon first-join notice sent:')));
    assert.ok(!logs.some((message) => message.includes(`/gameserver/${noticeCtx.gameServer.id}/message`)));
  });

  it('does not privately notify for normal or ended Blood Moon state', async () => {
    await installNoticeWithConfig({ privateBloodMoonNoticeOnFirstJoin: true });
    for (const phase of ['normal:6', 'end:7']) {
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

  it('persists observed phase but keeps an unconfigured-channel announcement pending', async () => {
    await installNoticeWithConfig({ timeConsoleCommand: TEST_TIME_DAY_7_NOON });
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState');
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered');
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending');

    const first = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);

    assert.equal(first.success, true, `Expected first Blood Moon observation to succeed: ${JSON.stringify(first.logs)}`);
    assert.equal(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState'),
      'today:7',
    );
    assert.deepEqual(
      (await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered')) ?? [],
      [],
    );
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending'),
      ['today:7'],
    );
    const observedWriteLog = first.logs.findIndex((message) => /POST \/variables(?:\s|$)/.test(message));
    const firstAnnouncementLog = first.logs.findIndex((message) => (
      message.includes('skipped message: Today is the Blood Moon day...')
    ));
    assert.ok(observedWriteLog >= 0, `Expected observed-state variable creation: ${JSON.stringify(first.logs)}`);
    assert.ok(
      firstAnnouncementLog > observedWriteLog,
      `Observed state must be persisted before announcement delivery: ${JSON.stringify(first.logs)}`,
    );

    const repeated = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);

    assert.equal(repeated.success, true, `Expected repeated Blood Moon observation to succeed: ${JSON.stringify(repeated.logs)}`);
    assertLogContains(repeated.logs, 'skipped message: Today is the Blood Moon day...');
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending'),
      ['today:7'],
    );
  });

  it('honors BloodMoonRange by treating adjacent configured days as possible horde days', async () => {
    await installNoticeWithConfig({
      timeConsoleCommand: TEST_TIME_DAY_6_START,
      bloodMoonRangeDays: 1,
    });
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState');
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered');
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending');

    const execution = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);

    assert.equal(execution.success, true, `Expected range-aware Blood Moon observation to succeed: ${JSON.stringify(execution.logs)}`);
    assert.equal(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState'),
      'start:6',
    );
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending'),
      ['start:6'],
    );
    assertLogContains(execution.logs, 'skipped message: Blood Moon is starting...');
  });

  it('retains failed announcements in chronological order across a phase transition', async () => {
    await installNoticeWithConfig({ timeConsoleCommand: TEST_TIME_DAY_7_NOON });
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState');
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered');
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending');

    const today = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);
    assert.equal(today.success, true, `Expected today observation to succeed: ${JSON.stringify(today.logs)}`);
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending'),
      ['today:7'],
    );

    await installNoticeWithConfig({ timeConsoleCommand: TEST_TIME_DAY_7_START });
    const starting = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);

    assert.equal(starting.success, true, `Expected start observation to succeed: ${JSON.stringify(starting.logs)}`);
    assert.equal(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState'),
      'start:7',
    );
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending'),
      ['today:7', 'start:7'],
    );
    const todayLog = starting.logs.findIndex((message) => message.includes('skipped message: Today is the Blood Moon day...'));
    const startLog = starting.logs.findIndex((message) => message.includes('skipped message: Blood Moon is starting...'));
    assert.ok(todayLog >= 0, `Expected pending today retry: ${JSON.stringify(starting.logs)}`);
    assert.ok(startLog > todayLog, `Expected start after pending today: ${JSON.stringify(starting.logs)}`);

    const repeated = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);
    assert.equal(repeated.success, true, `Expected repeated start observation to succeed: ${JSON.stringify(repeated.logs)}`);
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending'),
      ['today:7', 'start:7'],
    );
  });

  it('serializes concurrent cron state machines without losing pending announcements', async () => {
    await installNoticeWithConfig({ timeConsoleCommand: TEST_TIME_DAY_7_NOON });
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState');
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered');
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodMonitorLock');
    const existingPending = Array.from({ length: 3 }, (_value, index) => `end:${index + 1}`);
    await setModuleVariable(
      client,
      noticeCtx.gameServer.id,
      mod.id,
      'discord7d2d:bloodPending',
      existingPending,
    );

    const executions = await triggerConcurrentCronjobExecutions('bloodMoonMonitor', 2, noticeCtx);

    for (const execution of executions) {
      assert.equal(execution.success, true, `Concurrent cron must serialize successfully: ${JSON.stringify(execution.logs)}`);
    }
    assert.ok(
      executions.some((execution) => execution.logs.some((message) => message.includes('Blood Moon monitor lock busy; waiting'))),
      `Expected one concurrent execution to wait for the lock: ${JSON.stringify(executions)}`,
    );
    assert.equal(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState'),
      'today:7',
    );
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered'),
      [],
    );
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending'),
      [...existingPending, 'today:7'],
    );
    assert.equal(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodMonitorLock'),
      undefined,
      'The lock must be released after both executions finish',
    );
  });

  it('reclaims an expired Blood Moon monitor lock by record id', async () => {
    await installNoticeWithConfig({ timeConsoleCommand: TEST_TIME_DAY_7_NOON });
    await setModuleVariable(
      client,
      noticeCtx.gameServer.id,
      mod.id,
      'discord7d2d:bloodMonitorLock',
      { owner: 'abandoned-execution', acquiredAt: 1, expiresAt: 2 },
    );

    const execution = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);

    assert.equal(execution.success, true, `Expired lock recovery must succeed: ${JSON.stringify(execution.logs)}`);
    assertLogContains(execution.logs, 'reclaiming stale Blood Moon monitor lock owned by abandoned-execution');
    assert.equal(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodMonitorLock'),
      undefined,
      'The replacement owner must release its lock',
    );
  });

  it('waits with bounded backoff and does not release another lock owner on timeout', async () => {
    await installNoticeWithConfig({ timeConsoleCommand: TEST_TIME_DAY_7_NOON });
    const otherOwner = {
      owner: 'active-other-execution',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 60000,
    };
    await setModuleVariable(
      client,
      noticeCtx.gameServer.id,
      mod.id,
      'discord7d2d:bloodMonitorLock',
      otherOwner,
    );
    const startedAt = Date.now();

    const execution = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(execution.success, false, `Lock acquisition timeout must fail clearly: ${JSON.stringify(execution.logs)}`);
    assertLogContains(execution.logs, 'Blood Moon monitor lock busy; waiting');
    assertLogContains(execution.logs, 'Timed out waiting for Blood Moon monitor lock after 5000ms');
    assert.ok(elapsedMs >= 4500, `Expected real bounded backoff, but execution returned after ${elapsedMs}ms`);
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodMonitorLock'),
      otherOwner,
      'An acquisition failure must not release the active owner',
    );
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodMonitorLock');
  });

  it('uses the current installation config when an older queued execution acquires the lock later', async () => {
    await installNoticeWithConfig({
      hordeIntervalDays: 1,
      firstHordeDay: 7,
      timeConsoleCommand: TEST_TIME_DAY_7_NOON,
    });
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState', 'start:7');
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered', ['start:7']);
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending', []);
    await setModuleVariable(
      client,
      noticeCtx.gameServer.id,
      mod.id,
      'discord7d2d:bloodMonitorLock',
      { owner: 'test-config-change', acquiredAt: Date.now(), expiresAt: Date.now() + 60000 },
    );
    const cronjob = mod.latestVersion.cronJobs.find((candidate) => candidate.name === 'bloodMoonMonitor');
    assert.ok(cronjob);
    const beforeTrigger = new Date();

    await client.cronjob.cronJobControllerTrigger({
      gameServerId: noticeCtx.gameServer.id,
      moduleId: mod.id,
      cronjobId: cronjob.id,
    });
    await installNoticeWithConfig({
      hordeIntervalDays: 1,
      firstHordeDay: 7,
      timeConsoleCommand: TEST_TIME_DAY_8_AFTER_END,
    });
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodMonitorLock');

    const event = await waitForBridgeEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: noticeCtx.gameServer.id,
      moduleId: mod.id,
      after: beforeTrigger,
      predicate: (candidate) => (
        (candidate.meta as { cronjob?: { id?: string } }).cronjob?.id === cronjob.id
      ),
    });
    const result = (event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } }).result;
    const logs = (result?.logs ?? []).map((entry) => entry.msg);
    assert.equal(result?.success, true, `Queued execution must succeed with current config: ${JSON.stringify(logs)}`);
    assert.equal(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState'),
      'today:8',
      'A queued old installation snapshot must not overwrite current Blood Moon state',
    );
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending'),
      ['end:7', 'today:8'],
    );
  });

  it('exits safely when a queued execution outlives its module installation', async () => {
    await installNoticeWithConfig({ timeConsoleCommand: TEST_TIME_DAY_7_NOON });
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState', 'normal:6');
    await setModuleVariable(
      client,
      noticeCtx.gameServer.id,
      mod.id,
      'discord7d2d:bloodMonitorLock',
      { owner: 'test-uninstall-gap', acquiredAt: Date.now(), expiresAt: Date.now() + 60000 },
    );
    const cronjob = mod.latestVersion.cronJobs.find((candidate) => candidate.name === 'bloodMoonMonitor');
    assert.ok(cronjob);
    const beforeTrigger = new Date();

    await client.cronjob.cronJobControllerTrigger({
      gameServerId: noticeCtx.gameServer.id,
      moduleId: mod.id,
      cronjobId: cronjob.id,
    });
    await uninstallModule(client, mod.id, noticeCtx.gameServer.id);
    noticeInstalled = false;
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodMonitorLock');

    const event = await waitForBridgeEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: noticeCtx.gameServer.id,
      moduleId: mod.id,
      after: beforeTrigger,
      predicate: (candidate) => (
        (candidate.meta as { cronjob?: { id?: string } }).cronjob?.id === cronjob.id
      ),
    });
    const result = (event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } }).result;
    const logs = (result?.logs ?? []).map((entry) => entry.msg);
    assert.equal(result?.success, true, `Uninstalled queued execution must exit safely: ${JSON.stringify(logs)}`);
    assertLogContains(logs, 'module installation no longer exists, skipped Blood Moon monitor');
    assert.equal(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState'),
      'normal:6',
      'An uninstalled queued execution must not mutate observed state',
    );
    assert.equal(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodMonitorLock'),
      undefined,
      'An uninstalled queued execution must still release its lock',
    );
  });

  it('migrates a matching legacy announcement without duplicating it', async () => {
    await installNoticeWithConfig({ timeConsoleCommand: TEST_TIME_DAY_7_NOON });
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState', 'today:7');
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered');
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending');

    const execution = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);

    assert.equal(execution.success, true, `Expected legacy migration to succeed: ${JSON.stringify(execution.logs)}`);
    assert.ok(
      !execution.logs.some((message) => message.includes('Today is the Blood Moon day...')),
      `The current legacy announcement must not duplicate during migration: ${JSON.stringify(execution.logs)}`,
    );
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered'),
      ['today:7'],
    );
  });

  it('migrates an earlier legacy announcement before recording current work', async () => {
    await installNoticeWithConfig({ timeConsoleCommand: TEST_TIME_DAY_7_NOON });
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState', 'start:6');
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered');
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending');
    const stateRecords = await client.variable.variableControllerSearch({
      filters: {
        key: ['discord7d2d:bloodState'],
        gameServerId: [noticeCtx.gameServer.id],
        moduleId: [mod.id],
      },
    });
    const stateRecord = stateRecords.data.data[0];
    assert.ok(stateRecord, 'Expected seeded legacy state record');

    const execution = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);

    assert.equal(execution.success, true, `Expected legacy migration and current delivery to succeed: ${JSON.stringify(execution.logs)}`);
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered'),
      ['start:6'],
    );
    assertLogContains(execution.logs, 'skipped message: Today is the Blood Moon day...');
    const commandFinished = execution.logs.findIndex((message) => (
      message.includes(`/gameserver/${noticeCtx.gameServer.id}/command 200 OK`)
    ));
    const deliveredCreated = execution.logs.findIndex((message, index) => (
      index > commandFinished && /POST \/variables(?:\s|$)/.test(message)
    ));
    const observedUpdated = execution.logs.findIndex((message) => (
      message.includes(`PUT /variables/${stateRecord.id}`)
    ));
    const pendingCreated = execution.logs.findIndex((message, index) => (
      index > observedUpdated && /POST \/variables(?:\s|$)/.test(message)
    ));
    const announcementAttempted = execution.logs.findIndex((message) => (
      message.includes('skipped message: Today is the Blood Moon day...')
    ));
    assert.ok(commandFinished >= 0, `Expected current-time command proof: ${JSON.stringify(execution.logs)}`);
    assert.ok(
      deliveredCreated > commandFinished,
      `Delivered history must initialize after deriving current state: ${JSON.stringify(execution.logs)}`,
    );
    assert.ok(
      observedUpdated > deliveredCreated,
      `Delivered history must persist before observed state changes: ${JSON.stringify(execution.logs)}`,
    );
    assert.ok(
      pendingCreated > observedUpdated,
      `Observed state must persist before pending work: ${JSON.stringify(execution.logs)}`,
    );
    assert.ok(
      announcementAttempted > pendingCreated,
      `Pending work must persist before Discord delivery: ${JSON.stringify(execution.logs)}`,
    );
  });

  it('bounds delivered Blood Moon announcement history to 32 unique keys', async () => {
    await installNoticeWithConfig({ timeConsoleCommand: TEST_TIME_DAY_7_NOON });
    const oversizedHistory = [
      'start:1',
      'start:1',
      ...Array.from({ length: 34 }, (_value, index) => `end:${index + 1}`),
    ];
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState', 'normal:6');
    await setModuleVariable(
      client,
      noticeCtx.gameServer.id,
      mod.id,
      'discord7d2d:bloodDelivered',
      oversizedHistory,
    );
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending', []);

    const execution = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);

    assert.equal(execution.success, true, `Expected bounded delivery tracking to succeed: ${JSON.stringify(execution.logs)}`);
    const delivered = await readModuleVariable(
      client,
      noticeCtx.gameServer.id,
      mod.id,
      'discord7d2d:bloodDelivered',
    ) as string[];
    assert.equal(delivered.length, 32);
    assert.equal(new Set(delivered).size, delivered.length);
    assert.equal(delivered.at(-1), 'end:34');
    assert.ok(!delivered.includes('today:7'));
  });

  it('bounds pending Blood Moon announcements to 32 unique chronological keys', async () => {
    await installNoticeWithConfig({ timeConsoleCommand: TEST_TIME_DAY_7_NOON });
    const oversizedPending = [
      'start:1',
      'start:1',
      ...Array.from({ length: 34 }, (_value, index) => `end:${index + 1}`),
    ];
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState', 'normal:6');
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered', []);
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending', oversizedPending);

    const execution = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);

    assert.equal(execution.success, true, `Expected bounded pending tracking to succeed: ${JSON.stringify(execution.logs)}`);
    const pending = await readModuleVariable(
      client,
      noticeCtx.gameServer.id,
      mod.id,
      'discord7d2d:bloodPending',
    ) as string[];
    assert.equal(pending.length, 32);
    assert.equal(new Set(pending).size, pending.length);
    assert.equal(pending.at(-1), 'today:7');
  });

  it('keeps interval-one current state while prior end and current today remain pending in order', async () => {
    await installNoticeWithConfig({
      hordeIntervalDays: 1,
      firstHordeDay: 7,
      timeConsoleCommand: TEST_TIME_DAY_8_AFTER_END,
      privateBloodMoonNoticeOnFirstJoin: true,
      monitorJoins: false,
    });
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState', 'start:7');
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered', ['start:7']);
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending', []);

    const first = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);

    assert.equal(first.success, true, `Expected interval-one overlap to succeed: ${JSON.stringify(first.logs)}`);
    assert.equal(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState'),
      'today:8',
    );
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered'),
      ['start:7'],
    );
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending'),
      ['end:7', 'today:8'],
    );
    const endLog = first.logs.findIndex((message) => message.includes('skipped message: Blood Moon is ending...'));
    const todayLog = first.logs.findIndex((message) => message.includes('skipped message: Today is the Blood Moon day...'));
    assert.ok(endLog >= 0, `Expected prior end announcement: ${JSON.stringify(first.logs)}`);
    assert.ok(todayLog > endLog, `Expected current today announcement after prior end: ${JSON.stringify(first.logs)}`);

    const repeated = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);
    assert.equal(repeated.success, true, `Expected interval-one repeat to succeed: ${JSON.stringify(repeated.logs)}`);
    assertLogContains(repeated.logs, 'skipped message: Blood Moon is ending...');
    assertLogContains(repeated.logs, 'skipped message: Today is the Blood Moon day...');
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending'),
      ['end:7', 'today:8'],
    );

    const joinLogs = await triggerHook('player-connected', {
      playerId: noticeCtx.players[0].playerId,
      serverContext: noticeCtx,
    });
    assertLogContains(joinLogs, `/gameserver/${noticeCtx.gameServer.id}/message 200 OK`);
    assertLogContains(joinLogs, 'private blood moon first-join notice sent: Today is the Blood Moon day...');
  });

  it('[live smoke] delivers the private notice before a configured Discord join failure remains visible', {
    skip: DISCORD_FORBIDDEN_CHANNEL_ID ? false : 'Live smoke gate skipped: set TAKARO_DISCORD_FORBIDDEN_CHANNEL_ID',
  }, async () => {
    assert.ok(DISCORD_FORBIDDEN_CHANNEL_ID);
    await installNoticeWithConfig({
      monitoringChannelId: DISCORD_FORBIDDEN_CHANNEL_ID,
      privateBloodMoonNoticeOnFirstJoin: true,
      timeConsoleCommand: TEST_TIME_DAY_7_NOON,
    });
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState');
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered');
    await deleteModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending');

    const firstCron = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);

    assert.equal(firstCron.success, false, `Configured Discord failure must fail the cron: ${JSON.stringify(firstCron.logs)}`);
    assert.equal(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState'),
      'today:7',
      'Observed phase must persist before Discord delivery',
    );
    assert.deepEqual(
      (await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered')) ?? [],
      [],
      'A failed Discord announcement must remain pending',
    );
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending'),
      ['today:7'],
    );
    assertLogContains(firstCron.logs, `/discord/channels/${DISCORD_FORBIDDEN_CHANNEL_ID}/message`);

    const retryCron = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);

    assert.equal(retryCron.success, false, `Pending Discord announcement must retry: ${JSON.stringify(retryCron.logs)}`);
    assertLogContains(retryCron.logs, `/discord/channels/${DISCORD_FORBIDDEN_CHANNEL_ID}/message`);

    const execution = await triggerHookExecution('player-connected', {
      playerId: noticeCtx.players[0].playerId,
      serverContext: noticeCtx,
    });

    assert.equal(execution.success, false, `Configured Discord failure must fail the hook: ${JSON.stringify(execution.logs)}`);
    assertLogContains(execution.logs, `/gameserver/${noticeCtx.gameServer.id}/message 200 OK`);
    assertLogContains(execution.logs, 'private blood moon first-join notice sent: Today is the Blood Moon day...');
    assertLogContains(execution.logs, `Takaro or Discord refused delivery to channel ${DISCORD_FORBIDDEN_CHANNEL_ID}`);
  });

  it('[live smoke] records successful interval-one announcements individually and does not duplicate them', {
    skip: DISCORD_TEST_CHANNEL_ID ? false : 'Live smoke gate skipped: set TAKARO_DISCORD_TEST_CHANNEL_ID',
  }, async () => {
    assert.ok(DISCORD_TEST_CHANNEL_ID);
    await installNoticeWithConfig({
      hordeIntervalDays: 1,
      firstHordeDay: 7,
      monitoringChannelId: DISCORD_TEST_CHANNEL_ID,
      timeConsoleCommand: TEST_TIME_DAY_8_AFTER_END,
    });
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodState', 'start:7');
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered', ['start:7']);
    await setModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending', []);

    const first = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);

    assert.equal(first.success, true, `Expected Blood Moon Discord delivery to succeed: ${JSON.stringify(first.logs)}`);
    const successfulSends = first.logs
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.includes(`/discord/channels/${DISCORD_TEST_CHANNEL_ID}/message 200 OK`));
    assert.equal(successfulSends.length, 2, `Expected prior end and current today Discord sends: ${JSON.stringify(first.logs)}`);
    assert.ok(
      first.logs.slice(successfulSends[0].index + 1, successfulSends[1].index)
        .some((message) => message.includes('PUT /variables/')),
      `First successful announcement must be recorded before the second send completes: ${JSON.stringify(first.logs)}`,
    );
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodDelivered'),
      ['start:7', 'end:7', 'today:8'],
    );
    assert.deepEqual(
      await readModuleVariable(client, noticeCtx.gameServer.id, mod.id, 'discord7d2d:bloodPending'),
      [],
    );

    const repeated = await triggerCronjobExecution('bloodMoonMonitor', noticeCtx);

    assert.equal(repeated.success, true, `Expected completed announcement check to succeed: ${JSON.stringify(repeated.logs)}`);
    assert.ok(
      !repeated.logs.some((message) => message.includes(`/discord/channels/${DISCORD_TEST_CHANNEL_ID}/message`)),
      `A successful announcement must not duplicate: ${JSON.stringify(repeated.logs)}`,
    );
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
    const before = await client.variable.variableControllerSearch({
      filters: {
        key: ['discord7d2d:bloodState'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [mod.id],
      },
    });
    const beforeState = before.data.data[0];
    assert.ok(beforeState, 'Expected the first cron to persist Blood Moon state');

    const repeated = await triggerCronjobExecution('bloodMoonMonitor');

    assert.equal(repeated.success, true, `Expected repeated blood moon polling to succeed, logs: ${JSON.stringify(repeated.logs)}`);
    const after = await client.variable.variableControllerSearch({
      filters: {
        key: ['discord7d2d:bloodState'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [mod.id],
      },
    });
    const afterState = after.data.data[0];
    assert.ok(afterState, 'Expected the Blood Moon state record to remain present');
    assert.equal(afterState.id, beforeState.id);
    assert.equal(afterState.value, beforeState.value);
    assert.equal(afterState.updatedAt, beforeState.updatedAt, 'An unchanged Blood Moon phase must not be rewritten');
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
