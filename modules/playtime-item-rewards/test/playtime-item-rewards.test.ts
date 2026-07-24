import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const DEFAULT_CONFIG = {
  playtimeIntervalMinutes: 120,
  selectionMode: 'single',
  rewardMessage: '{playerName} received {items} after {intervalMinutes} minutes of playtime.',
  messageDelivery: 'broadcast',
  items: [
    {
      name: 'stone',
      amount: 1,
      quality: '',
      dropChance: 100,
      enabled: true,
    },
  ],
  roleOverrides: [],
};

type ExecutionMeta = { result?: { success?: boolean; logs?: Array<{ msg: string }> } };

type ConfigProperty = {
  type?: string;
  minimum?: number;
  default?: number | string;
  description?: string;
  enum?: string[];
  items?: { properties?: Record<string, ConfigProperty> };
};

type RewardState = {
  schedules?: Record<string, {
    intervalMinutes: number;
    eligibleAtPlaytimeSeconds: number;
  }>;
  lastConsumedBucket?: number;
  lastOutcome?: string;
};

describe('playtime-item-rewards', () => {
  let client: Client;
  let ctx: MockServerContext | undefined;
  let moduleId: string | undefined;
  let versionId: string;
  let cronjobId: string;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;
    const cronjob = mod.latestVersion.cronJobs[0];
    assert.equal(mod.latestVersion.cronJobs.length, 1);
    assert.equal(cronjob?.name, 'grant-playtime-item-rewards');
    if (!cronjob) throw new Error('Expected grant-playtime-item-rewards cronjob');
    cronjobId = cronjob.id;
  });

  after(async () => {
    if (!ctx) return;
    if (moduleId) {
      try {
        await uninstallModule(client, moduleId, ctx.gameServer.id);
      } catch (_err) {
        // Ignore cleanup races.
      }
      try {
        await deleteModule(client, moduleId);
      } catch (err) {
        console.error('Cleanup: failed to delete playtime-item-rewards module:', err);
      }
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  it('pushes and installs the item-only reward module', async () => {
    const manifestPath = path.join(MODULE_DIR, 'module.json');
    assert.equal(fs.existsSync(manifestPath), true, 'Expected the playtime-item-rewards module manifest to exist');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      name?: string;
      description?: string;
      config?: { properties?: Record<string, ConfigProperty> };
    };
    assert.equal(manifest.name, 'playtime-item-rewards');
    assert.match(manifest.description ?? '', /item(?:-only)? rewards/i);
    assert.deepEqual(manifest.config?.properties?.messageDelivery?.enum, ['broadcast', 'private', 'both', 'off']);
    assert.equal(manifest.config?.properties?.messageDelivery?.default, 'broadcast');
    assert.equal(manifest.config?.properties?.playtimeIntervalMaximumMinutes?.type, 'integer');
    assert.equal(manifest.config?.properties?.playtimeIntervalMaximumMinutes?.minimum, 1);
    assert.equal(manifest.config?.properties?.playtimeIntervalMaximumMinutes?.default, 120);
    assert.match(
      manifest.config?.properties?.playtimeIntervalMaximumMinutes?.description ?? '',
      /set.*equal.*fixed/i,
    );
    assert.equal(
      manifest.config?.properties?.roleOverrides?.items?.properties?.playtimeIntervalMaximumMinutes?.type,
      'integer',
    );

    await installModule(client, versionId, ctx!.gameServer.id, {
      userConfig: DEFAULT_CONFIG,
    });
    await uninstallModule(client, moduleId!, ctx!.gameServer.id);
  });

  async function triggerCronjob(): Promise<{ success: boolean; logs: string[] }> {
    const triggeredAfter = new Date();
    await client.cronjob.cronJobControllerTrigger({
      gameServerId: ctx!.gameServer.id,
      cronjobId,
      moduleId: moduleId!,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: ctx!.gameServer.id,
      after: triggeredAfter,
      timeout: 30000,
    });

    const meta = event.meta as ExecutionMeta;
    return {
      success: meta.result?.success ?? false,
      logs: (meta.result?.logs ?? []).map((entry) => entry.msg),
    };
  }

  async function findRewardState(playerId: string): Promise<RewardState | null> {
    const result = await client.variable.variableControllerSearch({
      filters: {
        key: ['playtime_item_reward_state'],
        gameServerId: [ctx!.gameServer.id],
        moduleId: [moduleId!],
        playerId: [playerId],
      },
      limit: 1,
    });
    const variable = result.data.data[0];
    return variable ? JSON.parse(variable.value) as RewardState : null;
  }

  async function deleteRewardState(playerId: string): Promise<void> {
    const result = await client.variable.variableControllerSearch({
      filters: {
        key: ['playtime_item_reward_state'],
        gameServerId: [ctx!.gameServer.id],
        moduleId: [moduleId!],
        playerId: [playerId],
      },
    });
    await Promise.all(result.data.data.map((variable) => client.variable.variableControllerDelete(variable.id)));
  }

  it('selects and persists one interval for the current player cycle', async () => {
    const playerId = ctx!.players[0].playerId;
    await deleteRewardState(playerId);
    await installModule(client, versionId, ctx!.gameServer.id, {
      userConfig: {
        ...DEFAULT_CONFIG,
        playtimeIntervalMinutes: 120,
        playtimeIntervalMaximumMinutes: 300,
      },
    });

    try {
      const firstResult = await triggerCronjob();
      assert.equal(firstResult.success, true, `Expected cronjob success, logs: ${JSON.stringify(firstResult.logs)}`);
      assert.ok(
        firstResult.logs.some((msg) => msg.includes('no players reached a new playtime interval')),
        `Expected below-threshold log, got: ${JSON.stringify(firstResult.logs)}`,
      );

      const firstState = await findRewardState(playerId);
      assert.ok(firstState?.schedules, `Expected a persisted schedule, got: ${JSON.stringify(firstState)}`);
      const firstSchedules = firstState.schedules;
      const firstSchedule = Object.values(firstSchedules)[0];
      assert.equal(Object.keys(firstSchedules).length, 1);
      assert.ok(firstSchedule, `Expected one schedule, got: ${JSON.stringify(firstSchedules)}`);
      assert.ok(firstSchedule.intervalMinutes >= 120 && firstSchedule.intervalMinutes <= 300);
      assert.equal(firstSchedule.eligibleAtPlaytimeSeconds, firstSchedule.intervalMinutes * 60);

      const secondResult = await triggerCronjob();
      assert.equal(secondResult.success, true, `Expected second cronjob success, logs: ${JSON.stringify(secondResult.logs)}`);
      const secondState = await findRewardState(playerId);
      assert.deepEqual(secondState?.schedules, firstSchedules, 'Expected repeated cron runs to reuse the selected interval');
    } finally {
      await uninstallModule(client, moduleId!, ctx!.gameServer.id);
    }
  });

  it('normalizes a maximum below the minimum to a fixed minimum interval', async () => {
    const playerId = ctx!.players[0].playerId;
    await deleteRewardState(playerId);
    await installModule(client, versionId, ctx!.gameServer.id, {
      userConfig: {
        ...DEFAULT_CONFIG,
        playtimeIntervalMinutes: 300,
        playtimeIntervalMaximumMinutes: 120,
      },
    });

    try {
      const result = await triggerCronjob();
      assert.equal(result.success, true, `Expected cronjob success, logs: ${JSON.stringify(result.logs)}`);
      const state = await findRewardState(playerId);
      assert.ok(state?.schedules, `Expected a persisted schedule, got: ${JSON.stringify(state)}`);
      const schedule = Object.values(state.schedules)[0];
      assert.ok(schedule, `Expected one schedule, got: ${JSON.stringify(state.schedules)}`);
      assert.equal(schedule.intervalMinutes, 300);
      assert.equal(schedule.eligibleAtPlaytimeSeconds, 300 * 60);
    } finally {
      await uninstallModule(client, moduleId!, ctx!.gameServer.id);
    }
  });

  it.skip('consumes an eligible cycle once and skips a second run before the next threshold (Paper live test)', () => {
    // @takaro/mock-gameserver does not expose or advance playtimeSeconds. This exact
    // positive path is exercised against Paper in the mandatory live verification.
  });
});
