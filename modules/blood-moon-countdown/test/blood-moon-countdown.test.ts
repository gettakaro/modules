import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, EventSearchInputAllowedFiltersEventNameEnum, ModuleOutputDTO } from '@takaro/apiclient';
import { createClient } from '../../../test/helpers/client.js';
import { waitForEvent } from '../../../test/helpers/events.js';
import { startMockServer, stopMockServer, MockServerContext } from '../../../test/helpers/mock-server.js';
import {
  cleanupTestGameServers,
  cleanupTestModules,
  deleteModule,
  getCommandPrefix,
  installModule,
  pushModule,
  uninstallModule,
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');

describe('blood-moon-countdown commands', () => {
  let client: Client;
  let ctx: MockServerContext;
  let mod: ModuleOutputDTO;
  let prefix: string;
  let testModuleDir: string;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    // Never replace a real module with the same name in the shared test domain.
    testModuleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-blood-moon-countdown-'));
    await fs.cp(MODULE_DIR, testModuleDir, { recursive: true });
    const moduleJsonPath = path.join(testModuleDir, 'module.json');
    const moduleJson = JSON.parse(await fs.readFile(moduleJsonPath, 'utf8')) as { name: string };
    moduleJson.name = 'test-blood-moon-countdown';
    await fs.writeFile(moduleJsonPath, `${JSON.stringify(moduleJson, null, 2)}\n`);

    mod = await pushModule(client, testModuleDir);
    await installModule(client, mod.latestVersion.id, ctx.gameServer.id, {
      userConfig: {
        // The mock server returns this text through the real console-command API.
        // It exercises the same parser shape as live 7D2D `gettime` output.
        timeConsoleCommand: 'say Day 134, 23:15',
      },
    });
    prefix = await getCommandPrefix(client, ctx.gameServer.id);
  });

  after(async () => {
    try {
      await uninstallModule(client, mod.id, ctx.gameServer.id);
    } catch (err) {
      console.error('Cleanup: failed to uninstall module:', err);
    }
    try {
      await deleteModule(client, mod.id);
    } catch (err) {
      console.error('Cleanup: failed to delete module:', err);
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
    await fs.rm(testModuleDir, { recursive: true, force: true });
  });

  async function triggerCommand(trigger: 'bloodmoon' | 'day7') {
    const beforeTrigger = new Date();
    const player = ctx.players[0]!;

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}${trigger}`,
      playerId: player.playerId,
    });

    return waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: beforeTrigger,
      timeout: 30000,
    });
  }

  for (const trigger of ['bloodmoon', 'day7'] as const) {
    it(`executes ${trigger} with live-format console time`, async () => {
      const event = await triggerCommand(trigger);
      const meta = event.meta as {
        result?: {
          success?: boolean;
          logs?: Array<{
            msg: string;
            details?: {
              args?: Array<{
                body?: {
                  message?: string;
                  opts?: { recipient?: { gameId?: string } };
                };
              }>;
            };
          }>;
        };
      };
      const logEntries = meta.result?.logs ?? [];
      const logs = logEntries.map((entry) => entry.msg);

      assert.equal(meta.result?.success, true, `Expected ${trigger} to succeed, logs: ${JSON.stringify(logs)}`);
      assert.ok(
        logs.some(
          (msg) =>
            msg.includes('currentDay=134') &&
            msg.includes('nextHordeDay=140') &&
            msg.includes('daysUntil=6') &&
            msg.includes('source=console'),
        ),
        `Expected parsed countdown proof in logs, got: ${JSON.stringify(logs)}`,
      );
      assert.ok(
        logEntries.some((entry) =>
          entry.details?.args?.some(
            (argument) =>
              argument.body?.message === 'Blood moon: Day 140. Current day: 134. 6 day(s) remaining.' &&
              argument.body.opts?.recipient?.gameId === ctx.players[0]!.gameId,
          ),
        ),
        `Expected a private countdown message with a player recipient, got: ${JSON.stringify(logEntries)}`,
      );
    });
  }

  it('imports only the approved 7D2D command surface', () => {
    assert.deepEqual(mod.supportedGames, ['7 days to die']);
    assert.deepEqual(
      mod.latestVersion.commands.map((command) => command.name).sort(),
      ['bloodmoon', 'day7'],
    );
    assert.deepEqual(mod.latestVersion.hooks, []);
  });

  it('rejects unparseable console time without sending a fallback countdown', async () => {
    const parseErrorMessage = 'Blood moon time is unavailable.';
    await uninstallModule(client, mod.id, ctx.gameServer.id);
    await installModule(client, mod.latestVersion.id, ctx.gameServer.id, {
      userConfig: {
        // `version` succeeds on the mock connector but contains no parseable day.
        timeConsoleCommand: 'version',
        parseErrorMessage,
      },
    });

    const event = await triggerCommand('bloodmoon');
    const meta = event.meta as {
      result?: {
        success?: boolean;
        logs?: Array<{
          msg: string;
          details?: unknown;
        }>;
      };
    };
    const result = meta.result;
    const logEntries = result?.logs ?? [];
    const serializedLogs = JSON.stringify(logEntries);

    assert.equal(result?.success, false, `Expected parse failure, got: ${JSON.stringify(result)}`);
    assert.ok(
      serializedLogs.includes(parseErrorMessage) && serializedLogs.includes('TakaroUserError'),
      `Expected configured player error, got: ${JSON.stringify(result)}`,
    );
    assert.ok(
      logEntries.some((entry) => entry.msg.includes('failed to parse day')),
      `Expected parse-failure diagnostics, got: ${JSON.stringify(logEntries)}`,
    );
    assert.ok(
      !serializedLogs.includes('"body":{"message"'),
      `Expected no fallback countdown message, got: ${JSON.stringify(logEntries)}`,
    );
  });
});
