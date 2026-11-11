import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client, EventSearchInputAllowedFiltersEventNameEnum } from '@takaro/apiclient';
import { createClient } from '../../../test/helpers/client.js';
import { startMockServer, stopMockServer, MockServerContext } from '../../../test/helpers/mock-server.js';
import { waitForEvent } from '../../../test/helpers/events.js';
import {
  pushModule,
  installModule,
  uninstallModule,
  deleteModule,
  cleanupTestModules,
  cleanupTestGameServers,
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');

describe('reboot-warnings: fixed warning cronjobs', () => {
  let client: Client;
  let ctx: MockServerContext | undefined;
  let moduleId: string;
  let versionId: string;
  let cronjobIdsByName: Record<string, string>;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);

    ctx = await startMockServer(client);

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;
    cronjobIdsByName = Object.fromEntries(mod.latestVersion.cronJobs.map((cronjob) => [cronjob.name, cronjob.id]));

    for (const expectedName of ['warning60', 'warning30', 'warning15', 'warning5', 'warning1']) {
      assert.ok(cronjobIdsByName[expectedName], `Expected cronjob ${expectedName} to be imported`);
    }
  });

  after(async () => {
    if (!ctx) return;
    try {
      await uninstallModule(client, moduleId, ctx.gameServer.id);
    } catch (_err) {
      // Ignore — individual tests may already have uninstalled it.
    }
    try {
      await deleteModule(client, moduleId);
    } catch (err) {
      console.error('Cleanup: failed to delete module:', err);
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  async function installWithConfig(userConfig: Record<string, unknown>): Promise<void> {
    await installModule(client, versionId, ctx!.gameServer.id, { userConfig });
  }

  async function triggerCronjob(cronjobName: string): Promise<{ success: boolean; logs: string[] }> {
    const triggerBefore = new Date();
    await client.cronjob.cronJobControllerTrigger({
      gameServerId: ctx!.gameServer.id,
      cronjobId: cronjobIdsByName[cronjobName],
      moduleId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: ctx!.gameServer.id,
      after: triggerBefore,
      timeout: 30000,
    });

    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    return {
      success: meta?.result?.success ?? false,
      logs: (meta?.result?.logs ?? []).map((l) => l.msg),
    };
  }

  it('sends the configured warning for the triggered cronjob only', async () => {
    await installWithConfig({
      warning60: {
        enabled: true,
        message: 'Restart in {minutesRemaining} minutes; {playerCount} player(s) online.',
      },
      warning30: {
        enabled: true,
        message: 'This should not be sent by warning60.',
      },
      skipWhenNoPlayersOnline: true,
    });

    try {
      const { success, logs } = await triggerCronjob('warning60');
      assert.equal(success, true, `Expected warning60 cronjob to succeed, logs: ${JSON.stringify(logs)}`);
      assert.ok(
        logs.some((log) => log.includes('sending warning60') && log.includes('Restart in 60 minutes')),
        `Expected warning60 rendered message in logs, got: ${JSON.stringify(logs)}`,
      );
      assert.ok(
        logs.every((log) => !log.includes('This should not be sent')),
        `warning60 should not send warning30 message, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      await uninstallModule(client, moduleId, ctx!.gameServer.id);
    }
  });

  it('disabled warning succeeds quietly without broadcasting', async () => {
    await installWithConfig({
      warning30: {
        enabled: false,
        message: 'Restart in 30 minutes.',
      },
    });

    try {
      const { success, logs } = await triggerCronjob('warning30');
      assert.equal(success, true, `Expected disabled warning30 cronjob to succeed, logs: ${JSON.stringify(logs)}`);
      assert.ok(
        logs.some((log) => log.includes('warning30 disabled, skipping')),
        `Expected disabled skip log, got: ${JSON.stringify(logs)}`,
      );
      assert.ok(
        logs.every((log) => !log.includes('broadcast complete')),
        `Disabled warning should not broadcast, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      await uninstallModule(client, moduleId, ctx!.gameServer.id);
    }
  });

  it('blank message succeeds quietly without broadcasting', async () => {
    await installWithConfig({
      warning5: {
        enabled: true,
        message: '   ',
      },
    });

    try {
      const { success, logs } = await triggerCronjob('warning5');
      assert.equal(success, true, `Expected blank warning5 cronjob to succeed, logs: ${JSON.stringify(logs)}`);
      assert.ok(
        logs.some((log) => log.includes('warning5 message is blank, skipping')),
        `Expected blank-message skip log, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      await uninstallModule(client, moduleId, ctx!.gameServer.id);
    }
  });
});
