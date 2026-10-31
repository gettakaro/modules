import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest } from '@takaro/module-test';
import type { ModuleTest, PermissionFixture } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);

const group = 'Geo Block (module-VM)';

/**
 * The harness default `permissions: 'ROOT'` makes `checkPermission` immune to GeoBlock, so a
 * non-immunity case below must override it or short-circuit at `IPDetected.js`'s first branch.
 */
const NO_PERMISSIONS: PermissionFixture = [];

/** The fields `TakaroEventPlayerNewIpDetected` carries; only `country` is read by the hook. */
function ipDetected(country: string) {
  return { city: 'nowhere', country, latitude: '0', longitude: '0', ip: '198.51.100.7' };
}

function logMessages(result: { logs: Array<{ msg: string }> }): string[] {
  return result.logs.map((log) => log.msg);
}

/**
 * Neither branch of `handleAction()` ran — a module-VM case can only prove the module did not ask
 * for a kick or ban, so it asserts both calls rather than the absence of a disconnect event.
 */
function expectNoAction(test: ModuleTest) {
  expect(test.client.stubs.gameserver.gameServerControllerKickPlayer).to.not.have.been.called;
  expect(test.client.stubs.player.banControllerCreate).to.not.have.been.called;
}

const tests = [
  createModuleTest({
    name: 'DENY MODE: Non-blocked country detected -> no action taken',
    module: MODULE,
    permissions: NO_PERMISSIONS,
    userConfig: { mode: 'deny', countries: ['RU'], ban: false },
    test: async function () {
      const result = await this.runHook('IPDetected', { eventData: ipDetected('BE') });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(logMessages(result)).to.deep.equal(['Allowed country detected, no action']);
      expectNoAction(this);
    },
  }),

  createModuleTest({
    name: 'ALLOW MODE: Allowed country detected -> no action taken',
    module: MODULE,
    permissions: NO_PERMISSIONS,
    userConfig: { mode: 'allow', countries: ['RU'], ban: false },
    test: async function () {
      const result = await this.runHook('IPDetected', { eventData: ipDetected('RU') });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(logMessages(result)).to.deep.equal(['Allowed country detected, no action']);
      expectNoAction(this);
    },
  }),

  createModuleTest({
    name: 'IMMUNITY PERMISSION: Player with GEOBLOCK_IMMUNITY permission is neither kicked nor banned',
    module: MODULE,
    // Config deliberately bans: `RU` is denied and `ban` is on, so the immunity branch is the
    // only thing standing between this fixture and a `banControllerCreate` call.
    permissions: [{ permission: 'GEOBLOCK_IMMUNITY' }],
    userConfig: { mode: 'deny', countries: ['RU'], ban: true, message: 'Custom message' },
    test: async function () {
      const result = await this.runHook('IPDetected', { eventData: ipDetected('RU') });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(logMessages(result)).to.deep.equal(['Player has immunity, no action']);
      expectNoAction(this);
    },
  }),

  createModuleTest({
    name: 'NO COUNTRIES CONFIGURED: No action taken if countries array is empty',
    module: MODULE,
    permissions: NO_PERMISSIONS,
    userConfig: { mode: 'deny', countries: [], ban: true, message: 'Custom message' },
    test: async function () {
      const result = await this.runHook('IPDetected', { eventData: ipDetected('BE') });

      expect(result.success, JSON.stringify(result.logs)).to.be.true;
      expect(logMessages(result)).to.deep.equal(['Allowed country detected, no action']);
      expectNoAction(this);
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
