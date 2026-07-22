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

type RewardState = {
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
      config?: { properties?: Record<string, { enum?: string[]; default?: string }> };
    };
    assert.equal(manifest.name, 'playtime-item-rewards');
    assert.match(manifest.description ?? '', /item(?:-only)? rewards/i);
    assert.deepEqual(manifest.config?.properties?.messageDelivery?.enum, ['broadcast', 'private', 'both', 'off']);
    assert.equal(manifest.config?.properties?.messageDelivery?.default, 'broadcast');

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

  it('does not create state or grant before the configured interval', async () => {
    const playerId = ctx!.players[0].playerId;
    await deleteRewardState(playerId);
    await installModule(client, versionId, ctx!.gameServer.id, {
      userConfig: {
        ...DEFAULT_CONFIG,
        playtimeIntervalMinutes: 999999,
      },
    });

    try {
      const result = await triggerCronjob();
      assert.equal(result.success, true, `Expected cronjob success, logs: ${JSON.stringify(result.logs)}`);
      assert.ok(
        result.logs.some((msg) => msg.includes('no players reached a new playtime interval')),
        `Expected below-threshold log, got: ${JSON.stringify(result.logs)}`,
      );
      assert.equal(await findRewardState(playerId), null);
    } finally {
      await uninstallModule(client, moduleId!, ctx!.gameServer.id);
    }
  });

  it.skip('consumes an eligible bucket once and skips a second run in the same bucket (Paper live test)', () => {
    // @takaro/mock-gameserver does not expose or advance playtimeSeconds. This exact
    // positive path is exercised against Paper in the mandatory live verification.
  });
});
