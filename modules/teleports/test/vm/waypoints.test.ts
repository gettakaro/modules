import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { randomUUID } from 'node:crypto';
import { executeVM } from '@takaro/helpers';
import {
  buildCommandData,
  createModuleTest,
  paginated,
  single,
  toJobPayload,
  type ModuleExport,
  type ModuleTest,
} from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'Teleports waypoints (module-VM)';

const HOME = { x: 10, y: 64, z: -20, dimension: 'overworld' };
const ELSEWHERE = { x: 999, y: 1, z: 999, dimension: 'nether' };

interface CatalogueModule {
  id: string;
  name: string;
  source: 'official' | 'community' | 'custom';
  sourceModuleName: string | null;
}

// Models Takaro's module search for the two parameters the lookup sends: `filters.source` and
// the partial (ILIKE) `search.name`. An exact `filters.name` is honoured too, so the old by-name
// lookup would see the user's module.
function stubModuleSearch(t: ModuleTest, catalogue: CatalogueModule[]) {
  t.client.stubs.module.moduleControllerSearch?.callsFake(async (query) => {
    const { filters = {}, search = {} } = (query ?? {}) as {
      filters?: { source?: string[]; name?: string[] };
      search?: { name?: string[] };
    };
    const found = catalogue
      .filter((mod) => !filters.source || filters.source.includes(mod.source))
      .filter((mod) => !filters.name || filters.name.includes(mod.name))
      .filter((mod) => !search.name || search.name.some((term) => mod.name.includes(term)))
      .map((mod) => ({
        id: mod.id,
        name: mod.name,
        source: mod.source,
        latestVersion: { id: randomUUID(), tag: 'latest', sourceModuleName: mod.sourceModuleName },
      }));
    return paginated(found);
  });
}

// The harness gives a command run a random `itemId`, but teleportwaypoint resolves itself by it,
// so it is triggered here through the harness's own payload builder with the id set. In Takaro
// this code runs as a per-server copy named `waypoint <trigger> server <gameServerId>`.
async function runWaypoint(t: ModuleTest, trigger: string) {
  const template = t.installation.version.commands.find((command) => command.name === 'teleportwaypoint');
  if (!template) {throw new Error('teleportwaypoint is missing from the module');}
  template.name = `waypoint ${trigger} server ${t.gameServerId}`;
  template.trigger = trigger;

  const data = buildCommandData(
    { domainId: t.domainId, gameServerId: t.gameServerId, installation: t.installation, player: t.player, pog: t.pog },
    { command: template },
  );
  return executeVM({
    fn: template.function.code,
    data: toJobPayload({ ...data, itemId: template.id }),
    userModules: t.installation.version.functions
      .filter((fn) => Boolean(fn.name))
      .map((fn) => ({ name: fn.name as string, code: fn.code })),
    clientOverride: t.client.asClient,
  });
}

async function seedWaypoint(t: ModuleTest, moduleId: string, name: string, position: typeof HOME) {
  await t.client.asClient.variable.variableControllerCreate({
    key: `waypoint ${name}`,
    value: JSON.stringify(position),
    gameServerId: t.gameServerId,
    moduleId,
  });
}

const WAYPOINTS_MODULE: ModuleExport = {
  name: 'Waypoints',
  versions: [{ tag: 'latest', description: 'Per-server waypoint commands', configSchema: '{}' }],
};

const tests = [
  createModuleTest({
    name: 'teleportwaypoint uses the official teleports module when a user module is named teleports',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      const userModuleId = randomUUID();
      stubModuleSearch(this, [
        { id: userModuleId, name: 'teleports', source: 'custom', sourceModuleName: null },
        { id: this.moduleId, name: 'teleports-1a2b3c4d', source: 'official', sourceModuleName: 'teleports' },
      ]);
      await seedWaypoint(this, userModuleId, 'home', ELSEWHERE);
      await seedWaypoint(this, this.moduleId, 'home', HOME);

      const result = await runWaypoint(this, 'home');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.module.moduleControllerSearch).to.have.been.calledOnceWith({
        filters: { source: ['official'] },
        search: { name: ['teleports'] },
      });
      expect(this.client.stubs.gameserver.gameServerControllerTeleportPlayer).to.have.been.calledOnceWith(
        this.gameServerId,
        this.pog.playerId,
        HOME,
      );
      expect(this.pms()).to.deep.equal(['Teleported to waypoint home.']);
    },
  }),

  createModuleTest({
    name: 'teleportwaypoint ignores an official module that is not teleports but matches the name search',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      stubModuleSearch(this, [
        { id: randomUUID(), name: 'teleports-extra', source: 'official', sourceModuleName: 'teleports-extra' },
        { id: this.moduleId, name: 'teleports', source: 'official', sourceModuleName: 'teleports' },
      ]);
      await seedWaypoint(this, this.moduleId, 'home', HOME);

      const result = await runWaypoint(this, 'home');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.gameserver.gameServerControllerTeleportPlayer).to.have.been.calledOnceWith(
        this.gameServerId,
        this.pog.playerId,
        HOME,
      );
    },
  }),

  createModuleTest({
    name: 'teleportwaypoint fails with a user error when no official teleports module exists',
    module: MODULE,
    permissions: 'ROOT',
    test: async function () {
      stubModuleSearch(this, [{ id: randomUUID(), name: 'teleports', source: 'custom', sourceModuleName: null }]);

      const result = await runWaypoint(this, 'home');

      expect(result.success).to.be.false;
      expect(this.userError(result)).to.equal(
        'The official teleports module is not available, so waypoints cannot be used.',
      );
      expect(this.client.stubs.gameserver.gameServerControllerTeleportPlayer).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: 'Waypoint reconciler copies teleportwaypoint from the installed version, not another version',
    module: MODULE,
    permissions: 'ROOT',
    alsoInstalled: [{ module: WAYPOINTS_MODULE }],
    test: async function () {
      const installed = this.installation.version.commands.find((command) => command.name === 'teleportwaypoint');
      if (!installed) {throw new Error('teleportwaypoint is missing from the module');}
      const otherVersionCopy = { ...installed, id: randomUUID(), versionId: randomUUID(), function: { ...installed.function, code: '// another version' } };
      const commandRows = [
        { command: otherVersionCopy, moduleId: this.moduleId },
        { command: installed, moduleId: this.moduleId },
      ];
      this.client.stubs.command.commandControllerSearch?.callsFake(async (query) => {
        const filters = (query?.filters ?? {}) as { moduleId?: string[]; versionId?: string[]; name?: string[] };
        return paginated(
          commandRows
            .filter((row) => !filters.moduleId || filters.moduleId.includes(row.moduleId))
            .filter((row) => !filters.versionId || filters.versionId.includes(row.command.versionId))
            .filter((row) => !filters.name || filters.name.includes(row.command.name))
            .map((row) => row.command),
        );
      });
      this.client.stubs.command.commandControllerCreate?.callsFake(async () => single({}));
      this.client.stubs.module.moduleControllerUpdate?.callsFake(async () => single({}));
      await seedWaypoint(this, this.moduleId, 'home', HOME);

      const result = await this.runCronJob('Waypoint reconciler');

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(this.client.stubs.command.commandControllerSearch).to.have.been.calledOnceWith({
        filters: { moduleId: [this.moduleId], versionId: [this.installation.versionId], name: ['teleportwaypoint'] },
      });
      const create = this.client.stubs.command.commandControllerCreate;
      expect(create).to.have.been.calledOnce;
      expect(create?.firstCall.args[0]).to.include({
        name: `waypoint home server ${this.gameServerId}`,
        trigger: 'home',
        function: installed.function.code,
      });
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
